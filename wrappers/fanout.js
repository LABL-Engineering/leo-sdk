const aws = require("aws-sdk");
const async = require("async");
const eventIdFormat = "[z/]YYYY/MM/DD/HH/mm/";
const moment = require("moment");
/**
 * @param {function(BotEvent, LambdaContext, Callback)} handler function to the code handler
 * @param {function(QueueEvent): any} eventPartition function to return the value representing what partition for the event 
 */
module.exports = (handler, eventPartition, opts = {}) => {
	if (typeof eventPartition !== "function") {
		opts = eventPartition || {};
		eventPartition = opts.eventPartition;
	}
	opts = Object.assign({
		instances: 2,
		allowCheckpoint: false
	}, opts);

	//console.log("Fanout start");
	eventPartition = eventPartition || (event => event.eid);
	let leo = require("../index.js");
	let leoBotCheckpoint = leo.bot.checkpoint;
	let leoStreamsFromLeo = leo.streams.fromLeo;
	let leoBotCheckLock = leo.bot.checkLock;
	let leoBotReportComplete = leo.bot.reportComplete;
	let cronData;
	let checkpoints = {};

	function fixInstanceForLocal(cronData) {
		// Get fanout data from process env if running locally
		if (process.env.FANOUT_iid) {
			cronData.iid = parseInt(process.env.FANOUT_iid);
			cronData.icount = parseInt(process.env.FANOUT_icount);
			cronData.maxeid = process.env.FANOUT_maxeid;
		}
	}

	// Override reading from leo to only read up to the max event id send from the master.
	leo.streams.fromLeo = leo.read = (ID, queue, opts = {}) => {
		opts.maxOverride = min(opts.maxOverride, cronData.maxeid);
		console.log(`Reading Queue Wrapper. Bot: ${ID}, IID: ${cronData.iid}, Queue: ${queue}, Max: ${opts.maxOverride}`);
		let reader = leoStreamsFromLeo.call(leo.streams, ID, queue, opts)
		let stream = leo.streams.pipe(reader, leo.streams.through((obj, done) => {
			let partition = Math.abs(hashCode(eventPartition(obj))) % cronData.icount;
			//console.log(partition, cronData.iid, obj.eid)
			if (partition == cronData.iid) {
				done(null, obj);
			} else {
				done();
			}
		}));
		stream.checkpoint = reader.checkpoint;
		stream.get = reader.get;
		return stream;
	};

	// Override bot checkpointing to report back to the master
	if (opts.allowCheckpoint !== true) {
		leo.bot.checkpoint = function(id, event, params, done) {
			if (opts.allowCheckpoint) {
				return leoBotCheckpoint(id, event, params, done);
			}
			id = id.replace(/_reader$/, "");
			if (!(id in checkpoints)) {
				checkpoints[id] = {
					read: {},
					write: {}
				};
			}
			let botData = checkpoints[id][params.type || "read"];
			if (!(event in botData)) {
				botData[event] = {
					records: 0,
				};
			}
			botData[event].checkpoint = params.eid || params.kinesis_number;
			botData[event].records += params.units || params.records || 0;
			botData[event].source_timestamp = params.source_timestamp;
			botData[event].started_timestamp = params.started_timestamp;
			botData[event].ended_timestamp = params.ended_timestamp;
			console.log(`Checkpoint Wrapper. Bot: ${id}:${cronData.iid}, Queue: ${event}, data: ${JSON.stringify(params)}`);
			done();
		}
	}

	// Override checking for bot lock.  This has already been done in the master
	leo.bot.checkLock = function(cron, runid, remainingTime, callback) {
		fixInstanceForLocal(cron);
		console.log("Fanout Check Lock", cron.iid);
		if (cron.iid == 0) {
			leoBotCheckLock(cron, runid, remainingTime, callback);
		} else {
			console.log(`Worker Instance CheckLock: ${cron.iid}`);
			callback(null, {});
		}
	};
	leo.bot.reportComplete = function(cron, runid, status, log, opts, callback) {
		console.log("Fanout Report Complete", cron.iid);
		if (cron.iid == 0) {
			leoBotReportComplete(cron, runid, status, log, opts, callback);
		} else {
			console.log(`Worker Instance ReportComplete: ${cron.iid}`);
			callback(null, {});
		}
	};


	//console.log("Fanout Return", process.env.FANOUT_iid, process.env.FANOUT_icount, process.env.FANOUT_maxeid);
	return (event, context, callback) => {

		cronData = event.__cron || {};

		// // Get fanout data from process env if running locally
		// if (process.env.FANOUT_iid) {
		// 	cronData.iid = parseInt(process.env.FANOUT_iid);
		// 	cronData.icount = parseInt(process.env.FANOUT_icount);
		// 	cronData.maxeid = process.env.FANOUT_maxeid;
		// }
		fixInstanceForLocal(cronData);

		console.log("Fanout Handler", cronData.iid);
		checkpoints = {};

		// If this is a worker then report back the checkpoints or error
		if (cronData.iid && cronData.icount) {
			console.log("Fanout Worker", cronData.iid);
			let context_getRemainingTimeInMillis = context.getRemainingTimeInMillis;
			context.getRemainingTimeInMillis = () => {
				return context_getRemainingTimeInMillis.call(context) - (1000 * 3);
			}
			return handler(event, context, (err, data) => {
				let response = {
					error: err,
					checkpoints: checkpoints,
					data: data,
					iid: cronData.iid
				};
				console.log("Worker sending data back", cronData.iid);
				if (process.send) {
					process.send(response);
				}
				callback(null, response);
			});
		} else {
			let timestamp = moment.utc();
			cronData.maxeid = timestamp.format(eventIdFormat) + timestamp.valueOf();
			cronData.iid = 0;
			console.log("Fanout Master", cronData.iid);
			// If this is the master start the workers needed Workers
			let instances = opts.instances;
			if (typeof instances === "function") {
				instances = instances(event, cronData);
			}
			instances = Math.max(1, Math.min(instances, opts.maxInstances || 20));
			cronData.icount = instances;
			let workers = [
				new Promise(resolve => {
					setTimeout(() => {
						console.log(`Invoking 1/${instances}`);
						return handler(event, context, (err, data) => {
							console.log(`Done with instance 1/${instances}`);
							resolve({
								error: err,
								checkpoints: checkpoints,
								data: data,
								iid: 0
							});
						});
					}, 200);
				})
			];
			for (let i = 1; i < instances; i++) {
				workers.unshift(invokeSelf(event, i, instances, context, handler));
			}

			// Wait for all workers to return and figure out what checkpoint to persist
			Promise.all(workers).then(responses => {
				let checkpoints = reduceCheckpoints(responses).map(data => (done) => leoBotCheckpoint(data.id, data.event, data.params, done));
				async.parallelLimit(checkpoints, 5, callback);
			}).catch(callback)
		}
	}
}

/**
 * @param {*} event The base event to send to the worker
 * @param {number} iid The instance id of this worker
 * @param {number} count The total number of workers
 * @param {*} context Lambda context object
 * @param {function(BotEvent, LambdaContext, Callback)} handler
 */
function invokeSelf(event, iid, count, context, handler) {
	console.log(`Invoking ${iid+1}/${count}`);
	let newEvent = JSON.parse(JSON.stringify(event));
	newEvent.__cron.iid = iid;
	newEvent.__cron.icount = count;
	return new Promise(resolve => {
		if (process.env.AWS_LAMBDA_FUNCTION_NAME) {
			let lambdaApi = new aws.Lambda({
				region: process.env.AWS_DEFAULT_REGION
			});
			lambdaApi.invoke({
				FunctionName: process.env.AWS_LAMBDA_FUNCTION_NAME,
				InvocationType: 'RequestResponse',
				Payload: JSON.stringify(newEvent),
				Qualifier: process.env.AWS_LAMBDA_FUNCTION_VERSION
			}, (err, data) => {
				if (!err && data.FunctionError) {
					err = data.Payload;
					data = undefined;
				} else if (!err && data.Payload != undefined && data.Payload != 'null') {
					data = JSON.parse(data.Payload);
				}

				console.log(`Done with instance ${iid+1}/${count}`);
				resolve(data);
			})
		} else {
			// Fork process with event
			let worker = require("child_process").fork(process.argv[1], process.argv.slice(2), {
				cwd: process.cwd(),
				env: Object.assign({}, process.env, {
					FANOUT_iid: iid,
					FANOUT_icount: count,
					FANOUT_maxeid: newEvent.__cron.maxeid,
					runner_keep_cmd: true
				}),
				execArgv: process.execArgv,
				//stdio: [s, s, s, 'ipc'],
				//shell: true
			});
			let responseData = {};
			worker.once("message", (response) => {
				console.log(`Got Response with instance ${iid+1}/${count}`);
				responseData = response;
			})
			worker.once("exit", () => {
				console.log(`Done with instance ${iid+1}/${count}`);
				resolve(responseData);
			});
		}
	});
}

/**
 * 
 * @param {[checkpoint]} responses Array of responses from the workers
 * @returns {[checkpoint]} Consolidated checkpoint
 */
function reduceCheckpoints(responses) {
	let checkpoints = responses.reduce((agg, curr) => {
		if (curr.error) {
			agg.errors.push(curr.error);
		}
		Object.keys(curr.checkpoints).map(botId => {
			if (!(botId in agg.checkpoints)) {
				agg.checkpoints[botId] = curr.checkpoints[botId];
			} else {
				let checkpointData = agg.checkpoints[botId].read;
				Object.keys(curr.checkpoints[botId].read || {}).map(queue => {
					if (!(queue in checkpointData)) {
						checkpointData[queue] = curr.checkpoints[botId].read[queue];
					} else {
						let minCheckpoint = min(checkpointData[queue].checkpoint, curr.checkpoints[botId].read[queue].checkpoint);
						if (minCheckpoint && minCheckpoint == curr.checkpoints[botId].read[queue].checkpoint) {
							checkpointData[queue] = curr.checkpoints[botId].read[queue];
						}
					}
				});
			}
		})
		return agg;
	}, {
		errors: [],
		checkpoints: {}
	});
	console.log(JSON.stringify(responses, null, 2));
	console.log(JSON.stringify(checkpoints, null, 2))
	//return Object.values(checkpoints);
	return [];
}

/**
 * @param {string|number} str Converts {str} to a hash code value
 */
function hashCode(str) {
	if (typeof str === "number") {
		return str;
	} else if (Array.isArray(str)) {
		let h = 0;
		for (let a = 0; a < str.length; a++) {
			h += hashCode(str[a]);
		}
		return h;
	}
	let hash = 0,
		i, chr;
	if (str.length === 0) return hash;
	for (i = 0; i < str.length; i++) {
		chr = str.charCodeAt(i);
		hash = ((hash << 5) - hash) + chr;
		hash |= 0; // Convert to 32bit integer
	}
	return hash;
}

function min(...args) {
	var current = args[0];
	for (var i = 1; i < args.length; ++i) {
		if (current == undefined) {
			current = args[i];
		} else if (args[i] != null && args[i] != undefined) {
			current = current < args[i] ? current : args[i];
		}
	}
	return current;
}

let numberRegex = /^\d+(?:\.\d*)?$/;
let boolRegex = /^(?:false|true)$/i;
let nullRegex = /^null$/;
let undefinedRegex = /^undefined$/;

function fixTypes(node) {
	let type = typeof node;
	if (Array.isArray(node)) {
		for (let i = 0; i < node.length; i++) {
			node[i] = fixTypes(node[i])
		}
	} else if (type == "object" && node !== null) {
		Object.keys(node).map(key => {
			node[key] = fixTypes(node[key]);
		})
	} else if (type == "string") {
		if (numberRegex.test(node)) {
			return parseFloat(node);
		} else if (boolRegex.test(node)) {
			return node.toLowerCase() == "true"
		} else if (nullRegex.test(node)) {
			return null;
		} else if (undefinedRegex.test(node)) {
			return undefined;
		}
	}

	return node;
}

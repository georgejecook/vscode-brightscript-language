import {
	DebugSession, InitializedEvent, TerminatedEvent, StoppedEvent, OutputEvent,
	Thread, StackFrame, Source, Breakpoint, Variable
} from 'vscode-debugadapter';
import { DebugProtocol } from 'vscode-debugprotocol';
import * as path from 'path';
import * as fsExtra from 'fs-extra';
import * as eol from 'eol';
import { RokuAdapter, EvaluateContainer } from './RokuAdapter';
import * as findInFiles from 'find-in-files';
import * as glob from 'glob';

class CompileFailureEvent implements DebugProtocol.Event {
    constructor(compileError: any) {
        this.body = compileError;
    }
    body: any;
    event: string;
    seq: number;
    type: string;
}

export class BrightScriptDebugSession extends DebugSession {
	public constructor() {
		super();
		// this debugger uses zero-based lines and columns
		this.setDebuggerLinesStartAt1(true);
		this.setDebuggerColumnsStartAt1(true);
	}

	//set imports as class properties so they can be spied upon during testing
	public rokuDeploy = require('roku-deploy');

	private rokuAdapterDeferred = defer<RokuAdapter>();

	private breakpointsByClientPath: { [clientPath: string]: DebugProtocol.Breakpoint[] } = {};
	private breakpointIdCounter = 0;
	private evaluateRefIdLookup: { [expression: string]: number } = {};
	private evaluateRefIdCounter = 1;

	private variables: { [refId: number]: AugmentedVariable } = {};

	private rokuAdapter: RokuAdapter;

	private getRokuAdapter() {
		return this.rokuAdapterDeferred.promise;
	}


	private launchArgs: LaunchRequestArguments;

	public get baseProjectPath() {
		return path.normalize(this.launchArgs.rootDir);
	}


	/**
	 * The 'initialize' request is the first request called by the frontend
	 * to interrogate the features the debug adapter provides.
	 */
	public initializeRequest(response: DebugProtocol.InitializeResponse, args: DebugProtocol.InitializeRequestArguments): void {
		this.log('initializeRequest');
		// since this debug adapter can accept configuration requests like 'setBreakpoint' at any time,
		// we request them early by sending an 'initializeRequest' to the frontend.
		// The frontend will end the configuration sequence by calling 'configurationDone' request.
		this.sendEvent(new InitializedEvent());
		response.body = response.body || {};

		// This debug adapter implements the configurationDoneRequest.
		response.body.supportsConfigurationDoneRequest = true;

		// make VS Code to use 'evaluate' when hovering over source
		response.body.supportsEvaluateForHovers = true;

		// make VS Code to show a 'step back' button
		response.body.supportsStepBack = false;

		this.sendResponse(response);
	}


	private launchRequestWasCalled = false;
	public async launchRequest(response: DebugProtocol.LaunchResponse, args: LaunchRequestArguments) {
		this.log('launchRequest');
		this.launchArgs = args;
		this.launchRequestWasCalled = true;
		let disconnect = () => { };

		let error: Error;
		console.log('Packaging and deploying to roku');
		try {
			//copy all project files to the staging folder
			let stagingFolder = await this.rokuDeploy.prepublishToStaging(args);

			//build a list of all files in the staging folder
			this.loadStagingDirPaths(stagingFolder);

			//convert source breakpoint paths to build paths
			if (this.launchArgs.debugRootDir) {
				this.convertBreakpointPaths(this.launchArgs.debugRootDir, this.launchArgs.rootDir);
			}

			//TODO add breakpoint lines to source files and then publish
			await this.addBreakpointStatements(stagingFolder);

			//convert source breakpoint paths to build paths
			if (this.launchArgs.debugRootDir) {
				this.convertBreakpointPaths(this.launchArgs.rootDir, this.launchArgs.debugRootDir);
			}

			//create zip package from staging folder
			await this.rokuDeploy.zipPackage(args);

			//connect to the roku debug via telnet
			await this.connectRokuAdapter(args.host);

			//pass along the console output
			if (this.launchArgs.consoleOutput === 'full') {
				this.rokuAdapter.on('console-output', (data) => {
					//forward the console output
					this.sendEvent(new OutputEvent(data, 'stdout'));
				});
			} else {
				this.rokuAdapter.on('unhandled-console-output', (data) => {
					//forward the console output
					this.sendEvent(new OutputEvent(data, 'stdout'));
				});
			}

			//listen for a closed connection (shut down when received)
			this.rokuAdapter.on('close', () => {
				error = new Error('Unable to connect to Roku. Is another device already connected?');
			});

			//watch 
			disconnect = this.rokuAdapter.on('compile-errors', (compileErrors) => {
				//for now, just alert the first error found
				let compileError = compileErrors[0];
        
        let clientPath = this.convertDebuggerPathToClient(compileError.path);
        this.sendEvent(new CompileFailureEvent(compileErrors));
				let clientLine = this.convertDebuggerLineToClientLine(compileError.path, compileError.lineNumber);
				error = new Error(`Compile error: ${clientPath}: ${clientLine}`);
			});

			//ignore the compile error failure from within the publish
			(args as any).failOnCompileError = false;
			//publish the package to the target Roku  
			await this.rokuDeploy.publish(args);

			//tell the adapter adapter that the channel has been launched. 
			await this.rokuAdapter.activate();

			if (!error) {
				console.log(`deployed to Roku@${args.host}`);
				this.sendResponse(response);
			} else {
				throw error;
			}
		} catch (e) {
			console.log(e);
			this.sendErrorResponse(response, -1, e.message);
			this.shutdown();
			return;
		} finally {
			//disconnect the compile error watcher
			disconnect();
		}
	}

	protected sourceRequest(response: DebugProtocol.SourceResponse, args: DebugProtocol.SourceArguments) {
		this.log('sourceRequest');
		let old = this.sendResponse;
		this.sendResponse = function (...args) {
			old.apply(this, args);
			this.sendResponse = old;
		};
		super.sourceRequest(response, args);
	}

	protected convertBreakpointPaths(fromRootPath: string, toRootPath: string) {
		//convert paths to debugRootDir paths for any breakpoints set before this launch call
		if (fromRootPath) {
			for (let clientPath in this.breakpointsByClientPath) {
				let debugClientPath = path.normalize(clientPath.replace(fromRootPath, toRootPath));
				this.breakpointsByClientPath[debugClientPath] = this.breakpointsByClientPath[clientPath];
				delete this.breakpointsByClientPath[clientPath];
			}
		}
	}


	protected configurationDoneRequest(response: DebugProtocol.ConfigurationDoneResponse, args: DebugProtocol.ConfigurationDoneArguments) {
		console.log('configurationDoneRequest');
	}

	protected setBreakPointsRequest(response: DebugProtocol.SetBreakpointsResponse, args: DebugProtocol.SetBreakpointsArguments) {
		this.log('setBreakpointsRequest');
		//roku currently only supports in-code breakpoints, so we can't add new breakpoints after the project is running.
		if (this.launchRequestWasCalled) {
			this.sendEvent(new OutputEvent('\nBreakpoints cannot be set during a debugging session', 'stdout'));
			return;
		}
		let clientPath = path.normalize(args.source.path);
		//if we have a debugRootDir, convert the rootDir path to debugRootDir path
		if (this.launchArgs && this.launchArgs.debugRootDir) {
			clientPath = clientPath.replace(this.launchArgs.rootDir, this.launchArgs.debugRootDir);
		}
		const clientLines = args.lines || [];
		let extension = path.extname(clientPath).toLowerCase();
		let actualBreakpoints: DebugProtocol.Breakpoint[] = [];

		//only accept breakpoints from brightscript files
		if (extension === '.brs') {
			// set and verify breakpoint locations
			actualBreakpoints = clientLines.map((lineNumber) => {
				const breakpoint = <DebugProtocol.Breakpoint>new Breakpoint(true, lineNumber);
				breakpoint.id = this.breakpointIdCounter++;
				return breakpoint;
			});

			//store the breakpoints indexed by clientPath
			this.breakpointsByClientPath[clientPath] = actualBreakpoints;
		}
		// send back the actual breakpoint positions
		response.body = {
			breakpoints: actualBreakpoints
		};
		this.sendResponse(response);
	}


	protected async exceptionInfoRequest(response: DebugProtocol.ExceptionInfoResponse, args: DebugProtocol.ExceptionInfoArguments) {
		this.log('exceptionInfoRequest');
	}

	protected async threadsRequest(response: DebugProtocol.ThreadsResponse) {
		this.log('threadsRequest');
		//wait for the roku adapter to load
		await this.getRokuAdapter();

		let threads = [];

		//only send the threads request if we are at the debugger prompt
		if (this.rokuAdapter.isAtDebuggerPrompt) {
			let rokuThreads = await this.rokuAdapter.getThreads();

			for (let thread of rokuThreads) {
				threads.push(
					new Thread(thread.threadId, `Thread ${thread.threadId}`)
				);
			}
		} else {
			console.log('Skipped getting threads because the RokuAdapter is not accepting input at this time.');
		}

		response.body = {
			threads: threads
		};

		this.sendResponse(response);
	}

	protected async stackTraceRequest(response: DebugProtocol.StackTraceResponse, args: DebugProtocol.StackTraceArguments) {
		this.log('stackTraceRequest');
		let frames = [];

		if (this.rokuAdapter.isAtDebuggerPrompt) {
			let stackTrace = await this.rokuAdapter.getStackTrace();

			for (let debugFrame of stackTrace) {

				let clientPath = this.convertDebuggerPathToClient(debugFrame.filePath);
				let clientLineNumber = this.convertDebuggerLineToClientLine(debugFrame.filePath, debugFrame.lineNumber);
				//the stacktrace returns function identifiers in all lower case. Try to get the actual case
				//load the contents of the file and get the correct casing for the function identifier
				try {
					let fileContents = (await fsExtra.readFile(clientPath)).toString();
					let match = new RegExp(`(?:sub|function)\\s+(${debugFrame.functionIdentifier})`, 'i').exec(fileContents);
					if (match) {
						debugFrame.functionIdentifier = match[1];
					}
				} catch (e) { }

				let frame = new StackFrame(
					debugFrame.frameId,
					`${debugFrame.functionIdentifier}`,
					new Source(path.basename(clientPath), clientPath),
					clientLineNumber,
					1
				);
				frames.push(frame);
			}
		} else {
			console.log('Skipped calculating stacktrace because the RokuAdapter is not accepting input at this time');
		}
		response.body = {
			stackFrames: frames,
			totalFrames: frames.length
		};
		this.sendResponse(response);
	}

	protected scopesRequest(response: DebugProtocol.ScopesResponse, args: DebugProtocol.ScopesArguments) {
		this.log('scopesRequest');

		this.sendResponse(response);
	}

	protected async continueRequest(response: DebugProtocol.ContinueResponse, args: DebugProtocol.ContinueArguments) {
		this.log('continueRequest');
		await this.rokuAdapter.continue();
		this.sendResponse(response);
	}

	protected async pauseRequest(response: DebugProtocol.PauseResponse, args: DebugProtocol.PauseArguments) {
		this.log('pauseRequest');
		await this.rokuAdapter.pause();
		this.sendResponse(response);
	}

	protected reverseContinueRequest(response: DebugProtocol.ReverseContinueResponse, args: DebugProtocol.ReverseContinueArguments) {
		this.log('reverseContinueRequest');
		this.sendResponse(response);
	}

	/**
	 * Clicked the "Step Over" button
	 * @param response 
	 * @param args 
	 */
	protected async nextRequest(response: DebugProtocol.NextResponse, args: DebugProtocol.NextArguments) {
		this.log('nextRequest');
		await this.rokuAdapter.stepOver();
		this.sendResponse(response);
	}

	protected async stepInRequest(response: DebugProtocol.StepInResponse, args: DebugProtocol.StepInArguments) {
		this.log('stepInRequest');
		await this.rokuAdapter.stepInto();
		this.sendResponse(response);
	}

	protected async stepOutRequest(response: DebugProtocol.StepOutResponse, args: DebugProtocol.StepOutArguments) {
		this.log('stepOutRequest');
		await this.rokuAdapter.stepOut();
		this.sendResponse(response);
	}

	protected stepBackRequest(response: DebugProtocol.StepBackResponse, args: DebugProtocol.StepBackArguments) {
		this.log('stepBackRequest');

		this.sendResponse(response);
	}

	public async variablesRequest(response: DebugProtocol.VariablesResponse, args: DebugProtocol.VariablesArguments) {
		this.log(`variablesRequest: ${JSON.stringify(args)}`);

		let childVariables: AugmentedVariable[] = [];
		if (this.rokuAdapter.isAtDebuggerPrompt) {
			//find the variable with this reference
			let v = this.variables[args.variablesReference];
			//query for child vars if we haven't done it yet.
			if (v.childVariables.length === 0) {
				let result = await this.rokuAdapter.getVariable(v.evaluateName);
				let tempVar = this.getVariableFromResult(result);
				v.childVariables = tempVar.childVariables;
			}
			childVariables = v.childVariables;
		} else {
			console.log('Skipped getting variables because the RokuAdapter is not accepting input at this time');
		}
		response.body = {
			variables: childVariables
		};
		this.sendResponse(response);
	}

	public async evaluateRequest(response: DebugProtocol.EvaluateResponse, args: DebugProtocol.EvaluateArguments) {
		if (this.rokuAdapter.isAtDebuggerPrompt) {
			if (['hover', 'watch'].indexOf(args.context) > -1 || args.expression.toLowerCase().trim().startsWith('print ')) {
				//if this command has the word print in front of it, remove that word
				let expression = args.expression.replace(/^print/i, '').trim();
				let refId = this.getEvaluateRefId(expression);
				let v: DebugProtocol.Variable;
				//if we already looked this item up, return it
				if (this.variables[refId]) {
					v = this.variables[refId];
				} else {
					let result = await this.rokuAdapter.getVariable(expression);
					v = this.getVariableFromResult(result);
				}
				response.body = {
					result: v.value,
					variablesReference: v.variablesReference,
					namedVariables: v.namedVariables || 0,
					indexedVariables: v.indexedVariables || 0
				};
			}
			//debug console typing
			else if (args.context === 'repl') {
				//exclude any of the standard interaction commands so we don't screw up the IDE's debugger state
				let excludedExpressions = ['cont', 'c', 'down', 'd', 'exit', 'over', 'o', 'out', 'step', 's', 't', 'thread', 'th', 'up', 'u'];
				if (excludedExpressions.indexOf(args.expression.toLowerCase().trim()) > -1) {
					this.sendEvent(new OutputEvent(`Expression '${args.expression}' not permitted when debugging in VSCode`, 'stdout'));
				} else {
					let result = await this.rokuAdapter.evaluate(args.expression);
					response.body = <any>{
						result
					};
					// //print the output to the screen
					// this.sendEvent(new OutputEvent(result, 'stdout'));
				}
			}
		} else {
			console.log('Skipped evaluate request because RokuAdapter is not accepting requests at this time');
		}

		this.sendResponse(response);
	}

	private loadStagingDirPaths(stagingDir: string) {
		if (!this.stagingDirPaths) {
			let paths = glob.sync(path.join(stagingDir, '**/*'));
			this.stagingDirPaths = [];
			for (let filePath of paths) {
				//make the path relative (+1 for removing the slash)
				let relativePath = filePath.substring(stagingDir.length + 1);
				this.stagingDirPaths.push(relativePath);
			}
		}
		return this.stagingDirPaths;
	}
	private stagingDirPaths: string[];

	/**
	 * Given a path from the debugger, convert it to a client path
	 * @param debuggerPath
	 */
	protected convertDebuggerPathToClient(debuggerPath: string) {
		//remove preceeding pkg: 
		if (debuggerPath.toLowerCase().indexOf('pkg:') === 0) {
			debuggerPath = debuggerPath.substring(4);
			//the debugger path was truncated, so try and map it to a file in the outdir
		} else if (debuggerPath.indexOf("...") === 0) {
			debuggerPath = debuggerPath.substring(3);
			//find any files from the outDir that end the same as this file
			let results: string[] = [];

			for (let stagingPath of this.stagingDirPaths) {
				let idx = stagingPath.indexOf(debuggerPath);
				//if the staging path looks like the debugger path, keep it for now
				if (idx > -1 && stagingPath.endsWith(debuggerPath)) {
					results.push(stagingPath);
				}
			}
			if (results.length === 1) {
				//we found a single match, this is the full relative path to the file we were looking for
				debuggerPath = results[0];
			} else {
				//we found multiple files with the exact same path (unlikely)...nothing we can do about it.
			}
		}
		//use debugRootDir if provided, or rootDir if not provided. 
		let rootDir = this.launchArgs.debugRootDir ? this.launchArgs.debugRootDir : this.launchArgs.rootDir;

		let clientPath = path.normalize(path.join(rootDir, debuggerPath));
		return clientPath;
	}

	/**
	 * Called when the host stops debugging
	 * @param response 
	 * @param args 
	 */
	protected async disconnectRequest(response: any, args: any) {
		if (this.rokuAdapter) {
			this.rokuAdapter.destroy();
		}
		//return to the home screen
		await this.rokuDeploy.pressHomeButton(this.launchArgs.host);
		this.sendResponse(response);
	}

	private async connectRokuAdapter(host: string) {
		//register events
		let firstSuspend = true;
		this.rokuAdapter = new RokuAdapter(host);

		//when the debugger suspends (pauses for debugger input)
		this.rokuAdapter.on('suspend', async () => {
			let threads = await this.rokuAdapter.getThreads();
			let threadId = threads[0].threadId;
			//determine if this is the "stop on entry" breakpoint
			let isStoppedOnEntry = firstSuspend && !!this.entryBreakpoint;

			//skip the breakpoint if this is the entry breakpoint and stopOnEntry is false
			if (isStoppedOnEntry && !this.launchArgs.stopOnEntry) {
				//skip the breakpoint 
				this.rokuAdapter.continue();
			} else {
				this.clearState();
				let exceptionText = '';
				const event: StoppedEvent = new StoppedEvent(StoppedEventReason.breakpoint, threadId, exceptionText);
				(event.body as any).allThreadsStopped = false;
				this.sendEvent(event);
			}
			firstSuspend = false;
		});

		//anytime the adapter encounters an exception on the roku,
		this.rokuAdapter.on('runtime-error', async (exception) => {
			let threads = await (await this.getRokuAdapter()).getThreads();
			let threadId = threads[0].threadId;
			this.sendEvent(new StoppedEvent('exception', threadId, exception.message));
		});

		// If the roku says it can't continue, we are no longer able to debug, so kill the debug session
		this.rokuAdapter.on('cannot-continue', () => {
			this.sendEvent(new TerminatedEvent());
		});
		//make the connection
		await this.rokuAdapter.connect();
		this.rokuAdapterDeferred.resolve(this.rokuAdapter);
	}



	/**
	 * Write "stop" lines into source code of each file for each breakpoint
	 * @param stagingPath
	 */
	public async addBreakpointStatements(stagingPath: string) {
		let promises = [];
		let addBreakpointsToFile = async (clientPath) => {
			let breakpoints = this.breakpointsByClientPath[clientPath];
			let stagingFilePath: string;
			//find the manifest file for the file
			clientPath = path.normalize(clientPath);
			let relativeClientPath = clientPath.toString().replace(this.baseProjectPath, '');
			stagingFilePath = path.join(stagingPath, relativeClientPath);
			//load the file as a string
			let fileContents = (await fsExtra.readFile(stagingFilePath)).toString();
			//split the file by newline
			let lines = eol.split(fileContents);
			for (let breakpoint of breakpoints) {
				//since arrays are indexed by zero, but the breakpoint lines are indexed by 1, we need to subtract 1 from the breakpoint line number
				let lineIndex = breakpoint.line - 1;
				let line = lines[lineIndex];
				//add a STOP statement right before this line
				lines[lineIndex] = `STOP\n${line} `;
			}
			fileContents = lines.join('\n');
			await fsExtra.writeFile(stagingFilePath, fileContents);
		};

		//add a breakpoint to the first line of the entry point method for consistency when debugging
		await this.addEntryBreakpoint();

		//add breakpoints to each client file
		for (let clientPath in this.breakpointsByClientPath) {
			promises.push(addBreakpointsToFile(clientPath));
		}
		await Promise.all(promises);
	}
	private entryBreakpoint: DebugProtocol.Breakpoint;
	private async addEntryBreakpoint() {
		let results = Object.assign(
			{},
			await findInFiles.find({ term: 'sub RunUserInterface\\(', flags: 'ig' }, this.baseProjectPath, /.*\.brs/),
			await findInFiles.find({ term: 'sub main\\(', flags: 'ig' }, this.baseProjectPath, /.*\.brs/)
		);
		let entryPath = Object.keys(results)[0];
		if (!entryPath) {
			throw new Error('Unable to find an entry point. Please make sure that you have a RunUserInterface or Main sub declared in your BrightScript project');
		}
		let entryLine = results[entryPath].line[0];
		let lineNumber: number;
		//load the file contents
		let contents = await fsExtra.readFile(entryPath);
		let lines = eol.split(contents.toString());
		//loop through the lines until we find the entry line
		for (let i = 0; i < lines.length; i++) {
			let line = lines[i];
			if (line.indexOf(entryLine) > -1) {
				lineNumber = i + 1;
				break;
			}
		}
		//create a breakpoint on the line BELOW this location, which is the first line of the program
		this.entryBreakpoint = <DebugProtocol.Breakpoint>new Breakpoint(true, lineNumber + 1);
		this.entryBreakpoint.id = this.breakpointIdCounter++;
		(this.entryBreakpoint as any).isEntryBreakpoint = true;
		//put this breakpoint into the list of breakpoints, in order
		let breakpoints = this.breakpointsByClientPath[entryPath] || [];
		breakpoints.push(this.entryBreakpoint);
		//sort the breakpoints in order of line number
		breakpoints.sort((a, b) => {
			if (a.line > b.line) {
				return 1;
			} else if (a.line < b.line) {
				return -1;
			} else {
				return 0;
			}
		});

		//if the user put a breakpoint on the first line of their program, we want to keep THEIR breakpoint, not the entry breakpoint
		let index = breakpoints.indexOf(this.entryBreakpoint);
		let bpBefore = breakpoints[index - 1];
		let bpAfter = breakpoints[index + 1];
		if (
			(bpBefore && bpBefore.line === this.entryBreakpoint.line) ||
			(bpAfter && bpAfter.line === this.entryBreakpoint.line)
		) {
			breakpoints.splice(index, 1);
			this.entryBreakpoint = undefined;
		}
		this.breakpointsByClientPath[entryPath] = breakpoints;
	}

	/**
	 * Given a full path to a file, walk up the tree until we have found the base project path (full path to the folder containing the manifest file)
	 * @param filePath
	 */
	// private async getBaseProjectPath(filePath: string) {
	// 	//try walking up 10 levels. If we haven't found it by then, there is nothing we can do.
	// 	let folderPath = filePath;
	// 	for (let i = 0; i < 10; i++) {
	// 		folderPath = path.dirname(folderPath);
	// 		let files = await Q.nfcall(glob, path.join(folderPath, 'manifest'));
	// 		if (files.length === 1) {
	// 			let dir = path.dirname(files[0]);
	// 			return path.normalize(dir);
	// 		}
	// 	}
	// 	throw new Error('Unable to find base project path');
	// }


	/**
	 * We set "breakpoints" by inserting 'STOP' lines into the code. So to translate the debugger lines back to client lines,
	 * we need to subtract those 'STOP' lines from the line count
	 * @param debuggerPath 
	 * @param debuggerLineNumber 
	 */
	private convertDebuggerLineToClientLine(debuggerPath: string, debuggerLineNumber: number) {
		let clientPath = this.convertDebuggerPathToClient(debuggerPath);
		let breakpoints = this.breakpointsByClientPath[clientPath] || [];

		let resultLineNumber = debuggerLineNumber;
		for (let breakpoint of breakpoints) {
			if (breakpoint.line <= resultLineNumber) {
				resultLineNumber--;
			} else {
				break;
			}
		}
		return resultLineNumber;
	}

	private log(...args) {
		console.log.apply(console, args);
	}

	private getVariableFromResult(result: EvaluateContainer) {
		let v: AugmentedVariable;
		if (result.highLevelType === 'primative' || result.highLevelType === 'uninitialized') {
			v = new Variable(result.name, `${result.value}`);
		} else if (result.highLevelType === 'array') {
			let refId = this.getEvaluateRefId(result.evaluateName);
			v = new Variable(result.name, result.type, refId, result.children.length, 0);
			this.variables[refId] = v;
		} else if (result.highLevelType === 'object') {
			let refId = this.getEvaluateRefId(result.evaluateName);
			v = new Variable(result.name, result.type, refId, 0, result.children.length);
			this.variables[refId] = v;
		} else if (result.highLevelType === 'function') {
			v = new Variable(result.name, result.value);
		}
		v.evaluateName = result.evaluateName;
		if (result.children) {
			let childVariables = [];
			for (let childContainer of result.children) {
				let childVar = this.getVariableFromResult(childContainer);
				childVariables.push(childVar);
			}
			v.childVariables = childVariables;
		}
		return v;
	}

	private getEvaluateRefId(expression: string) {
		if (!this.evaluateRefIdLookup[expression]) {
			this.evaluateRefIdLookup[expression] = this.evaluateRefIdCounter++;
		}
		return this.evaluateRefIdLookup[expression];
	}

	private clearState() {
		//erase all cached variables
		this.variables = {};
	}

}


/**
 * This interface should always match the schema found in the mock-debug extension manifest.
 */
interface LaunchRequestArguments extends DebugProtocol.LaunchRequestArguments {
	/**
	 * The host or ip address for the target Roku
	 */
	host: string;
	/**
	 * The password for the developer page on the target Roku
	 */
	password: string;
	/**
	 * The root directory that contains your Roku project. This path should point to the folder containing your manifest file
	 */
	rootDir: string;
	/**
	 * If you have a build system, rootDir will point to the build output folder, and this path should point to the actual source folder so that breakpoints can be set in the source files when debugging. In order for this to work, your build process cannot change line offsets between source files and built files, otherwise debugger lines will be out of sync.
	 */
	debugRootDir: string;
	/**
	 * The folder where the output files are places during the packaging process
	 */
	outDir?: string;
	/**
	 * If true, stop at the first executable line of the program
	 */
	stopOnEntry: boolean;
	/**
	 * Determines which console output event to listen for. Full is every console message (including the ones from the adapter). Normal excludes output initiated by the adapter
	 */
	consoleOutput: 'full' | 'normal';
}

interface AugmentedVariable extends DebugProtocol.Variable {
	childVariables?: AugmentedVariable[];
}


enum StoppedEventReason {
	step = 'step',
	breakpoint = 'breakpoint',
	exception = 'exception',
	pause = 'pause',
	entry = 'entry'
}

export function defer<T>() {
	let resolve: (value?: T | PromiseLike<T>) => void;
	let reject: (reason?: any) => void;
	let promise = new Promise<T>((_resolve, _reject) => {
		resolve = _resolve;
		reject = _reject;
	});
	return {
		promise,
		resolve,
		reject
	};
}
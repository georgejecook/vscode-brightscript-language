import * as request from 'request';
import * as vscode from 'vscode';
import * as path from 'path';

// tslint:disable-next-line
export var __request: any = request;

import BrightScriptFileUtils from './BrightScriptFileUtils';
import { BrightScriptDebugConfiguration } from './DebugConfigurationProvider';

// georgejecook: I can't find a way to stub/mock a TypeScript class constructor
// so I have to do this for the time being. Not ideal.
export function getBrightScriptCommandsInstance() {
    return new BrightScriptCommands();
}

export default class BrightScriptCommands {

    constructor() {
        this.fileUtils = new BrightScriptFileUtils();
    }

    private fileUtils: BrightScriptFileUtils;
    private context: vscode.ExtensionContext;
    private host: string;
    private rootDir: string;
    private debugRootDir: string;
    public function;
    private launchConfig: BrightScriptDebugConfiguration;

    public setLaunchConfig(launchConfig: BrightScriptDebugConfiguration) {
        this.launchConfig = launchConfig;
        this.rootDir = launchConfig.rootDir.replace('${workspaceFolder}', vscode.workspace.workspaceFolders[0].uri.fsPath);
        this.debugRootDir = launchConfig.debugRootDir.replace('${workspaceFolder}', vscode.workspace.workspaceFolders[0].uri.fsPath);
    }

    public registerCommands(context: vscode.ExtensionContext) {
        this.context = context;
        let subscriptions = context.subscriptions;

        subscriptions.push(vscode.commands.registerCommand('extension.brightscript.toggleXML', () => {
            this.onToggleXml();
        }));
        subscriptions.push(vscode.commands.registerCommand('extension.brightscript.toggleBuiltFile', () => {
            this.onToggleBuiltFile();
        }));
        subscriptions.push(vscode.commands.registerCommand('extension.brightscript.sendRemoteCommand', (key: string) => {
            this.sendRemoteCommand(key);
        }));

        subscriptions.push(vscode.commands.registerCommand('extension.brightscript.sendRemoteText', async () => {
            let stuffUserTyped: string = await vscode.window.showInputBox({
                placeHolder: 'Press enter to send all typed characters to the Roku',
                value: ''
            });
            if (stuffUserTyped) {
                for (let character of stuffUserTyped) {
                    let commandToSend: string = 'Lit_' + encodeURIComponent(character);
                    await this.sendRemoteCommand(commandToSend);
                }
            }
            vscode.commands.executeCommand('workbench.action.focusPanel');
        }));

        subscriptions.push(vscode.commands.registerCommand('extension.brightscript.pressBackButton', () => {
            this.sendRemoteCommand('Back');
        }));
        subscriptions.push(vscode.commands.registerCommand('extension.brightscript.pressBackspaceButton', () => {
            this.sendRemoteCommand('Backspace');
        }));
        subscriptions.push(vscode.commands.registerCommand('extension.brightscript.pressHomeButton', () => {
            this.sendRemoteCommand('Home');
        }));
        subscriptions.push(vscode.commands.registerCommand('extension.brightscript.pressUpButton', () => {
            this.sendRemoteCommand('Up');
        }));
        subscriptions.push(vscode.commands.registerCommand('extension.brightscript.pressDownButton', () => {
            this.sendRemoteCommand('Down');
        }));
        subscriptions.push(vscode.commands.registerCommand('extension.brightscript.pressRightButton', () => {
            this.sendRemoteCommand('Right');
        }));
        subscriptions.push(vscode.commands.registerCommand('extension.brightscript.pressLeftButton', () => {
            this.sendRemoteCommand('Left');
        }));
        subscriptions.push(vscode.commands.registerCommand('extension.brightscript.pressSelectButton', () => {
            this.sendRemoteCommand('Select');
        }));
        subscriptions.push(vscode.commands.registerCommand('extension.brightscript.pressPlayButton', () => {
            this.sendRemoteCommand('Play');
        }));
        subscriptions.push(vscode.commands.registerCommand('extension.brightscript.pressRevButton', () => {
            this.sendRemoteCommand('Rev');
        }));
        subscriptions.push(vscode.commands.registerCommand('extension.brightscript.pressFwdButton', () => {
            this.sendRemoteCommand('Fwd');
        }));
        subscriptions.push(vscode.commands.registerCommand('extension.brightscript.pressStarButton', () => {
            this.sendRemoteCommand('Info');
        }));
    }

    public async openFile(filename: string, range: vscode.Range = null, preview: boolean = false): Promise<boolean> {
        let uri = vscode.Uri.file(filename);
        try {
            let doc = await vscode.workspace.openTextDocument(uri); // calls back into the provider
            await vscode.window.showTextDocument(doc, { preview: preview });
            if (range) {
                this.gotoRange(range);
            }
        } catch (e) {
            return false;
        }
        return true;
    }

    private gotoRange(range: vscode.Range) {
        let editor = vscode.window.activeTextEditor;
        editor.selection = new vscode.Selection(
            range.start.line,
            range.start.character,
            range.start.line,
            range.start.character
        );
        vscode.commands.executeCommand('revealLine', {
            lineNumber: range.start.line,
            at: 'center'
        });
    }

    public async onToggleXml() {
        if (vscode.window.activeTextEditor) {
            const currentDocument = vscode.window.activeTextEditor.document;
            let alternateFileName = this.fileUtils.getAlternateFileName(currentDocument.fileName);
            if (alternateFileName) {
                if (! await this.openFile(alternateFileName)
                    && alternateFileName.toLowerCase().endsWith('.brs')) {
                    await this.openFile(this.fileUtils.getBsFileName(alternateFileName));
                }
            }
        }
    }

    public async  onToggleBuiltFile() {
        if (vscode.window.activeTextEditor) {
            const rootDir = vscode.workspace.rootPath;
            const currentDocument = vscode.window.activeTextEditor.document;
            let relativeBuildPath = this.launchConfig.rootDir.replace('${workspaceFolder}', '');
            relativeBuildPath = relativeBuildPath.replace(rootDir, '');
            let fsPath = currentDocument.uri.fsPath;
            let isOpened = false;

            for (let sourceDir of this.launchConfig.sourceDirs) {
                let relativeSourceDir = sourceDir.replace('${workspaceFolder}', '');
                relativeSourceDir = relativeSourceDir.replace(rootDir, '');
                const relativeFsPath = fsPath.replace(rootDir, '');

                let docPath = '';
                if (relativeFsPath.startsWith(relativeSourceDir)) {
                    //we are viewing a source path file, so we're going to show the built file
                    //it MUST be a brs
                    docPath = relativeFsPath.replace(relativeSourceDir, '');
                    docPath = path.join(rootDir, relativeBuildPath, docPath);
                    docPath = this.fileUtils.getBrsFileName(docPath);
                    isOpened = await this.openFile(docPath, vscode.window.activeTextEditor.selection);

                } else {
                    // we are viewing the build file, so we're going to show the source file
                    docPath = relativeFsPath.replace(relativeBuildPath, '');
                    docPath = path.join(rootDir, relativeSourceDir, docPath);
                    isOpened = await this.openFile(docPath, vscode.window.activeTextEditor.selection);
                    if (!isOpened) {
                        this.openFile(this.fileUtils.getAlternateBrsFileName(docPath), vscode.window.activeTextEditor.selection);
                    }
                }
                if (isOpened) {
                    break;
                }
            }
        }
    }

    public async sendRemoteCommand(key: string) {
        await this.getRemoteHost();
        if (this.host) {
            let clickUrl = `http://${this.host}:8060/keypress/${key}`;
            console.log(`send ${clickUrl}`);
            return new Promise(function(resolve, reject) {
                request.post(clickUrl, function(err, response) {
                    if (err) {
                        return reject(err);
                    }
                    return resolve(response);
                });
            });
        }
    }

    public async getRemoteHost() {
        this.host = await this.context.workspaceState.get('remoteHost');
        if (!this.host) {
            let config = await vscode.workspace.getConfiguration('brightscript.remoteControl', null);
            this.host = config.get('host');
            if (this.host === '${promptForHost}') {
                this.host = await vscode.window.showInputBox({
                    placeHolder: 'The IP address of your Roku device',
                    value: ''
                });
            }
        }
        if (!this.host) {
            throw new Error('Can\'t send command: host is required.');
        } else {
            await this.context.workspaceState.update('remoteHost', this.host);
        }
    }
}

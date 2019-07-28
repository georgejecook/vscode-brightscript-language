import * as vscode from 'vscode';

import {
    CancellationToken,
    CompletionItem,
    CompletionItemProvider,
    DebugConfiguration,
    DocumentSymbolProvider,
    Position,
    Range,
    SymbolInformation,
    TextDocument,
    Uri,
    WorkspaceFolder,
    WorkspaceSymbolProvider,
} from 'vscode';

import { ActiveDeviceManager } from './ActiveDeviceManager';
import { getBrightScriptCommandsInstance } from './BrightScriptCommands';
import BrightScriptCompletionItemProvider from './BrightScriptCompletionItemProvider';
import BrightScriptDefinitionProvider from './BrightScriptDefinitionProvider';
import { BrightScriptDocumentSymbolProvider } from './BrightScriptDocumentSymbolProvider';
import { BrightScriptReferenceProvider } from './BrightScriptReferenceProvider';
import BrightScriptSignatureHelpProvider from './BrightScriptSignatureHelpProvider';
import BrightScriptXmlDefinitionProvider from './BrightScriptXmlDefinitionProvider';
import { BrightScriptDebugConfigurationProvider as BrsDebugConfigurationProvider } from './DebugConfigurationProvider';
import { DeclarationProvider } from './DeclarationProvider';
import { DefinitionRepository } from './DefinitionRepository';
import { Formatter } from './formatter';
import { LogDocumentLinkProvider } from './LogDocumentLinkProvider';
import { LogOutputManager } from './LogOutputManager';
import {
    BrightScriptWorkspaceSymbolProvider,
    SymbolInformationRepository
} from './SymbolInformationRepository';

let outputChannel: vscode.OutputChannel;

export async function activate(context: vscode.ExtensionContext) {
    let activeDeviceManager = new ActiveDeviceManager();

    //register the code formatter
    vscode.languages.registerDocumentRangeFormattingEditProvider({
        language: 'brightscript',
        scheme: 'file'
    }, new Formatter());

    vscode.languages.registerDocumentRangeFormattingEditProvider({
        language: 'brighterscript',
        scheme: 'file'
    }, new Formatter());
    outputChannel = vscode.window.createOutputChannel('BrightScript Log');

    let configProvider = new BrsDebugConfigurationProvider(context, activeDeviceManager);
    context.subscriptions.push(vscode.debug.registerDebugConfigurationProvider('brightscript', configProvider));
    context.subscriptions.push(vscode.debug.registerDebugConfigurationProvider('brighterscript', configProvider));

    let docLinkProvider = new LogDocumentLinkProvider();
    //register a link provider for this extension's "BrightScript Log" output
    vscode.languages.registerDocumentLinkProvider({ language: 'Log' }, docLinkProvider);
    //give the launch config to the link provder any time we launch the app
    vscode.debug.onDidReceiveDebugSessionCustomEvent((e) => {
        if (e.event === 'BSLaunchStartEvent') {
            docLinkProvider.setLaunchConfig(e.body);
            logOutputManager.setLaunchConfig(e.body);
            brightScriptCommands.setLaunchConfig(e.body);
        }
    });

    //register the definition provider
    const declarationProvider: DeclarationProvider = new DeclarationProvider();
    const symbolInformationRepository = new SymbolInformationRepository(declarationProvider);
    const logOutputManager: LogOutputManager = new LogOutputManager(outputChannel, context, docLinkProvider, declarationProvider);
    const definitionRepo = new DefinitionRepository(declarationProvider);
    const definitionProvider = new BrightScriptDefinitionProvider(definitionRepo);
    const selector = { scheme: 'file', pattern: '**/*.{brs,bs}' };
    const brightScriptCommands = getBrightScriptCommandsInstance();
    brightScriptCommands.registerCommands(context);

    // experimental placeholder
    context.subscriptions.push(vscode.languages.registerCompletionItemProvider(selector, new BrightScriptCompletionItemProvider(), '.'));
    context.subscriptions.push(vscode.languages.registerDefinitionProvider(selector, definitionProvider));
    context.subscriptions.push(vscode.languages.registerDocumentSymbolProvider(selector, new BrightScriptDocumentSymbolProvider(declarationProvider)));
    context.subscriptions.push(vscode.languages.registerWorkspaceSymbolProvider(new BrightScriptWorkspaceSymbolProvider(declarationProvider, symbolInformationRepository)));
    context.subscriptions.push(declarationProvider);
    vscode.languages.registerReferenceProvider(selector, new BrightScriptReferenceProvider());
    vscode.languages.registerSignatureHelpProvider(selector, new BrightScriptSignatureHelpProvider(definitionRepo), '(', ',');

    vscode.debug.onDidStartDebugSession((e) => {
        logOutputManager.onDidStartDebugSession();
    });
    vscode.debug.onDidReceiveDebugSessionCustomEvent((e) => {
        logOutputManager.onDidReceiveDebugSessionCustomEvent(e);
    });

    //some of the services/subcriptions require the launchconfig to work
    const launchConfig = vscode.workspace.getConfiguration('launch');
    const configurations = launchConfig.configurations;
    let defaultLaunchConfig: any = configurations.find( (c) => true);
    if (defaultLaunchConfig) {
        docLinkProvider.setLaunchConfig(defaultLaunchConfig);
        logOutputManager.setLaunchConfig(defaultLaunchConfig);
        brightScriptCommands.setLaunchConfig(defaultLaunchConfig);

    }
    outputChannel.show();

    //xml support
    const xmlSelector = { scheme: 'file', pattern: '**/*.{xml}' };
    context.subscriptions.push(vscode.languages.registerDefinitionProvider(xmlSelector, new BrightScriptXmlDefinitionProvider(definitionRepo)));
}

export function deactivate() {
}

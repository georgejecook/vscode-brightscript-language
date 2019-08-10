import * as fsExtra from 'fs-extra';
import * as path from 'path';
import * as rokuDeploy from 'roku-deploy';
import { DocumentLink, Position, Range } from 'vscode';
import * as vscode from 'vscode';

import BrightScriptFileUtils from './BrightScriptFileUtils';
import { BrightScriptDebugConfiguration } from './DebugConfigurationProvider';

const fileUtils = new BrightScriptFileUtils();

export class CustomDocumentLink {
    constructor(outputLine: number, startChar: number, length: number, pkgPath: string, lineNumber: number, filename: string) {
        this.outputLine = outputLine;
        this.startChar = startChar;
        this.length = length;
        this.pkgPath = pkgPath;
        this.lineNumber = lineNumber;
        this.filename = filename;
    }

    public outputLine: number;
    public startChar: number;
    public length: number;
    public pkgPath: string;
    public filename: string;
    public lineNumber: number;
}
/**
 * Provides file links in any output window that has the pkg:/ format.
 * This only works after a debug session has started,  because the file mappings are provided in the debug launch arguments
 */
export class LogDocumentLinkProvider implements vscode.DocumentLinkProvider {
    constructor() {
        this.customLinks = [];
    }

    //add import as property so it can be mocked in tests
    private rokuDeploy = rokuDeploy;

    public async setLaunchConfig(launchConfig: BrightScriptDebugConfiguration) {
        this.launchConfig = launchConfig;
        this.fileMaps = {};

        let sourceRootDir = launchConfig.sourceDirs ? launchConfig.sourceDirs : [launchConfig.rootDir];
        let paths = [];
        for (const rootDir of sourceRootDir) {
            let pathsFromRoot = await this.rokuDeploy.getFilePaths(launchConfig.files, launchConfig.outDir, rootDir);
            paths = paths.concat(pathsFromRoot);
        }
        //get every file used in this project

        let outDir = path.normalize(launchConfig.outDir);

        //convert every path into a pkg link, which maps back to the source location of the file
        for (let fileMap of paths) {

            //make the dest path relative
            let pkgPath = 'pkg:/' + path.normalize(fileMap.dest).replace(outDir, '');
            //replace windows slashes with 'nix ones
            pkgPath = pkgPath.replace(/\\/g, '/');
            //replace double slashes with single ones
            pkgPath = pkgPath.replace(/\/\//g, '/');
            this.fileMaps[pkgPath] = {
                pkgPath: pkgPath,
                ...fileMap
            };
        }
    }

    public fileMaps: { [pkgPath: string]: { src: string; dest: string; pkgPath: string; } };
    public customLinks: DocumentLink[];

    private launchConfig: BrightScriptDebugConfiguration;

    public async provideDocumentLinks(doc: vscode.TextDocument, token: vscode.CancellationToken) {
        return this.customLinks;
    }

    public getFileMap(pkgPath) {
        return this.fileMaps[pkgPath];
    }

    public addCustomLink(customLink: CustomDocumentLink) {
        for (let i = 0; i < 2; i++) {
            let fileMap = this.getFileMap(customLink.pkgPath);
            if (fileMap) {
                let uri = vscode.Uri.file(fileMap.src);
                if (customLink.lineNumber) {
                    uri = uri.with({ fragment: customLink.lineNumber.toString().trim() });
                }
                let range = new Range(new Position(customLink.outputLine, customLink.startChar), new Position(customLink.outputLine, customLink.startChar + customLink.length));
                this.customLinks.push(new DocumentLink(range, uri));
                return;
            }
            customLink.pkgPath = fileUtils.getAlternateBrsFileName(customLink.pkgPath);
        }
        console.log('could not find matching file for link with path ' + customLink.pkgPath);
    }

    public resetCustomLinks() {
        this.customLinks = [];
    }

        /*
        georgejecook: would love to know a way to do this without the exists
        I think we need to standardize the functionality here, into a general purpose utility method
        which will help with rss support later, as well.
        */
    public convertPkgPathToFsPath(pkgPath: string) {
        //remove preceeding pkg:
        if (pkgPath.toLowerCase().indexOf('pkg:') === 0) {
            pkgPath = pkgPath.substring(4);
        }

        //use debugRootDir if provided, or rootDir if not provided.
        let rootDir = this.launchConfig.rootDir;
        for (let i = 0; i < 2; i++) {
            if (this.launchConfig.debugRootDir) {
                rootDir = this.launchConfig.debugRootDir;
                let clientPath = path.normalize(path.join(rootDir, pkgPath));
                if (fsExtra.existsSync(clientPath)) {
                    return clientPath;
                }
            }

            if (this.launchConfig.sourceDirs) {
                if (this.launchConfig.sourceDirs.length === 1) {
                //best case, simply choose the first item
                    rootDir = this.launchConfig.sourceDirs[0];
                    let clientPath = path.normalize(path.join(rootDir, pkgPath));
                    if (fsExtra.existsSync(clientPath)) {
                        return clientPath;
                    }

                } else {
                    for (let sourceDir of this.launchConfig.sourceDirs) {
                        let clientPath = path.normalize(path.join(sourceDir, pkgPath));
                        if (fsExtra.existsSync(clientPath)) {
                            return clientPath;
                        }
                    }
                }
            }
            pkgPath = fileUtils.getAlternateBrsFileName(pkgPath);
        }
        return pkgPath;
    }
}

import {
    CancellationToken,
    Definition,
    DefinitionProvider,
    Position,
    TextDocument
} from 'vscode';

import { DefinitionRepository } from './DefinitionRepository';

export default class BrightScriptDefinitionProvider implements DefinitionProvider {

    constructor(repo: DefinitionRepository) {
        this.repo = repo;
    }

    private repo: DefinitionRepository;

    public async provideDefinition(document: TextDocument, position: Position, token: CancellationToken): Promise<Definition> {
        try {
            await this.repo.sync();
        } catch (e) {
            console.error(e.message);
        }

        return Array.from(this.repo.find(document, position));
    }

}

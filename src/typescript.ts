import { NodeAPI, Node, NodeDef, NodeAPISettingsWithData } from 'node-red';
import * as vm from 'vm';
import ts from 'typescript';
import util from 'util';

interface TypeScriptNodeDef extends NodeDef {
    name: string;
    func: string;
    initialize?: string;
    finalize?: string;
    outputs: number;
    timeout?: number;
    useVm: boolean;
    updated?: number;
    libs?: Array<{var: string, module: string}>;
}

type Msg = {
    [name: string]: any
}

type SendFun = (msg: Msg|Msg[]) => void;
type DoneFun = (err?: any) => void;

interface Compilation {
    updated: number;
    ready: Promise<void>;
    fun: (msg: Msg, send: SendFun, done: DoneFun) => Promise<Msg|Msg[]>;
    ini: () => Promise<void>;
    fin: () => Promise<void>;
}

class NodeWrapper {
    constructor(
        private _n: any,
        private _s: SendFun,
        private _d: DoneFun,
        private _m: any,
    ) {}

    get id() { return this._n.id; }
    get name() { return this._n.name; }
    get path() { return this._n._path; }
    get outputCount() { return this._n.outputs; }

    log(...args: any[]) { return this._n.log(...args); }
    warn(...args: any[]) { return this._n.warn(...args); }
    error(...args: any[]) { return this._n.error(...args); }
    debug(...args: any[]) { return this._n.debug(...args); }
    trace(...args: any[]) { return this._n.trace(...args); }
    status(...args: any[]) {
        this._n.clearStatus = true;
        return this._n.status(...args);
    }

    on(...args: any[]) { return this._n.on(...args); }

    send(msg: Msg | Msg[]) {
        sendResults(this._s, this._m._msgid, msg);
    }

    done(err?: any) {
        this._d(err);
    }
}

const sendResults = (send: SendFun, msgid: string, msgs: any) => {
    if (msgs == null) return;
    if (!Array.isArray(msgs)) msgs = [msgs];
    for (const output of msgs) {
        if (!output) continue;
        const arr = Array.isArray(output) ? output : [output];
        for (const m of arr) {
            if (m && typeof m === 'object' && !Buffer.isBuffer(m)) m._msgid = msgid;
        }
    }
    send(msgs);
}

const getScriptTarget = (): ts.ScriptTarget => {
    const major = parseInt(process.version.slice(1).split('.')[0], 10);
    if (major >= 22) return ts.ScriptTarget.ES2024;
    if (major >= 20) return ts.ScriptTarget.ES2023;
    if (major >= 18) return ts.ScriptTarget.ES2022;
    if (major >= 16) return ts.ScriptTarget.ES2021;
    if (major >= 14) return ts.ScriptTarget.ES2020;
    return ts.ScriptTarget.ES2019;
}

const SCRIPT_TARGET = getScriptTarget();

function compileTypeScript(node: Node, script: string): string {
    try {
        node.log(`Compiling TypeScript (${script.length} chars)`);
        
        const result = ts.transpileModule(script, {
            compilerOptions: {
                target: SCRIPT_TARGET,
                module: ts.ModuleKind.CommonJS,
                moduleResolution: ts.ModuleResolutionKind.Node10,
                
                // Maximum permissiveness - allow everything
                allowJs: true,
                allowUnreachableCode: true,
                allowUnusedLabels: true,
                
                // Disable all strict checks
                strict: false,
                noImplicitAny: false,
                noImplicitThis: false,
                noImplicitReturns: false,
                noImplicitUseStrict: false,
                
                // Disable all error checking
                noUnusedLocals: false,
                noUnusedParameters: false,
                exactOptionalPropertyTypes: false,
                noUncheckedIndexedAccess: false,
                noPropertyAccessFromIndexSignature: false,
                
                // Skip all lib and declaration checks
                skipLibCheck: true,
                skipDefaultLibCheck: true,
                
                // Suppress warnings and errors
                suppressExcessPropertyErrors: true,
                suppressImplicitAnyIndexErrors: true,
                
                // Allow all JS features
                allowSyntheticDefaultImports: true,
                allowUmdGlobalAccess: true,
                
                // Disable emit checks
                noEmitOnError: false,
                
                // Maximum compatibility
                downlevelIteration: true,
                importHelpers: false
            }
        });
        
        // Check for TypeScript diagnostics
        if (result.diagnostics && result.diagnostics.length > 0) {
            const errors = result.diagnostics.map(diagnostic => {
                const message = ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n');
                if (diagnostic.file && diagnostic.start !== undefined) {
                    const { line, character } = diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start);
                    return `Line ${line + 1}:${character + 1}: ${message}`;
                }
                return message;
            }).join('\n');
            
            node.error(`TypeScript diagnostics:\n${errors}`);
        }
        
        node.log('TypeScript compilation successful');
        return result.outputText;
    } catch (error: any) {
        const json: any = {};
        try {
            json.stack = String(error.stack);
            json.message = String(error.message);
            json.errorKeys = Object.keys(error);
        } catch(e) {}
        try {
            const prototype = Object.getPrototypeOf(error);
            json.prototypeType = String(typeof prototype);
            json.prototypeKeys = Object.keys(prototype);
            json.prototypeName = String(prototype.name);
        } catch(e) {}
        throw new Error(`Compilation failed: ${JSON.stringify(json)}`);
    }
}

async function injectModules(scope: any, libs: any[], RED: any, node: Node): Promise<void> {
    if (!libs || libs.length === 0) return;
    
    const moduleLoadPromises = libs.map(async (lib) => {
        const vname = lib.var;
        if (!vname || vname === '') return;
        
        if (scope.hasOwnProperty(vname) || vname === 'node') {
            throw new Error(`Module variable name '${vname}' is reserved or already exists`);
        }
        
        try {
            // Use RED.import() as in the original code
            const loadedModule = await RED.import(lib.module);
            scope[vname] = loadedModule.default || loadedModule;
        } catch (err: any) {
            node.error(`Failed to load module '${lib.module}': ${err.message}`);
            throw err;
        }
    });
    
    await Promise.all(moduleLoadPromises);
}

async function newCompilation(node: TsNode, comp: Compilation, def: TypeScriptNodeDef, RED: any): Promise<void> {
    const useVm = def.useVm === true;
    const libs = def.libs || [];

    const funTs = def.func || '';
    const iniTs = def.initialize || '';
    const finTs = def.finalize || '';
    const timeout = Number(def.timeout) || (RED as any).settings?.globalFunctionTimeout || undefined;
    
    const funJs = compileTypeScript(node, `(async function(msg, node) { ${funTs} })(msg, node)`);
    const iniJs = compileTypeScript(node, `(async function() { ${iniTs} })()`);
    const finJs = compileTypeScript(node, `(async function() { ${finTs} })()`);
    
    const nodeContext = node.context();
    const nodeSend = (...args: any[]) => node.send(...args);
    const scope: any = {
        msg: {},
        node: new NodeWrapper(node, nodeSend, () => {}, {}),
        RED,
        __global: global,
        console,
        util,
        Buffer: Buffer,
        URL: URL,
        URLSearchParams: URLSearchParams,
        Date: Date,
        require,
        fetch,
        context: nodeContext,
        flow: nodeContext.flow,
        global: nodeContext.global,
        env: {
            get: (envVar: any) => RED.util.getSetting(node, envVar)
        },
        setTimeout: (handler: Function, delayMs?: number) => {
            const ref = setTimeout(() => {
                scope.clearTimeout(ref);
                try {
                    handler();
                } catch(err) {
                    node.error(err, {});
                }
            }, delayMs);
            node.timeouts.add(ref);
            return ref;
        },
        clearTimeout: (ref: any) => {
            clearTimeout(ref);
            node.timeouts.delete(ref);
        },
        setInterval: (handler: Function, delayMs?: number) => {
            const ref = setInterval(() => {
                try {
                    handler();
                } catch(err) {
                    node.error(err,{});
                }
            }, delayMs);
            node.intervals.add(ref);
            return ref;
        },
        clearInterval: (ref: any) => {
            clearInterval(ref);
            node.intervals.delete(ref);
        },
    };

    // Inject modules (including default ones defined in HTML)
    await injectModules(scope, libs, RED, node);

    if (!useVm) {
        const funArgs = Object.keys(scope);

        const fun = new Function(...funArgs, `return ${funJs}`);
        const ini = new Function(...funArgs, `return ${iniJs}`);
        const fin = new Function(...funArgs, `return ${finJs}`);

        comp.fun = async (msg, send, done) => {
            scope.msg = msg;
            scope.node = new NodeWrapper(node, send, done, msg);
            return fun(...funArgs.map(k => scope[k]));
        }
        comp.ini = () => ini(...funArgs.map(k => scope[k]));
        comp.fin = () => fin(...funArgs.map(k => scope[k]));
    }
    else {
        const vmCtx = vm.createContext(scope);
        const vmOptions: vm.RunningScriptOptions = {
            timeout,
            displayErrors: true
        };
        const funScript = new vm.Script(`var msg=_msg,node=_node; ${funJs}`);
        const iniScript = new vm.Script(iniJs);
        const finScript = new vm.Script(finJs);

        comp.fun = (msg, send, done) => {
            vmCtx._msg = msg;
            vmCtx._node = new NodeWrapper(node, send, done, msg);
            return funScript.runInContext(vmCtx, vmOptions);
        };
        comp.ini = () => iniScript.runInContext(vmCtx, vmOptions);
        comp.fin = () => finScript.runInContext(vmCtx, vmOptions);
    }

    try {
        await comp.ini();
    }
    catch (error: any) {
        node.error('Error in function initialize: ' + (error.stack || error.message))
    }
}

async function getCompilation(node: TsNode, def: TypeScriptNodeDef, RED: any): Promise<Compilation|undefined> {
    try {
        const updated: number = def.updated || 0;

        if (node.comp?.updated !== updated) {
            try {
                await node.comp?.fin();
            } catch (error: any) {
                node.error('Error in function finalize: ' + (error.stack || error.message));
            }
            node.comp = {
                updated,
                ready: Promise.resolve(),
                fun: () => { throw 'no fun' },
                ini: () => { throw 'no ini' },
                fin: () => { throw 'no fin' },
            };
            node.comp.ready = newCompilation(node, node.comp, def, RED);
        }

        await node.comp.ready;
        return node.comp;
    } catch (error: any) {
        node.error('Compilation error: ' + (error.stack || error.message));
        return undefined;
    }
}

interface TsNode extends Node {
    comp: Compilation | undefined;
    timeouts: Set<any>;
    intervals: Set<any>;
}

export = (RED: NodeAPI) => {
    const TypeScriptNode = function(this: TsNode, def: TypeScriptNodeDef) {
        RED.nodes.createNode(this, def);

        // Precompile on node creation
        getCompilation(this, def, RED);

        this.timeouts = new Set<any>();
        this.intervals = new Set<any>();
        
        this.on('input', async (msg: any, send: any, done: (err?: any) => void) => {
            const comp = await getCompilation(this, def, RED);
            if (!comp) { done(); return; }
            
            let doneCalled = false;
            const safeDone = (err?: any) => {
                if (!doneCalled) { doneCalled = true; done(err); }
            };

            try {
                const outputs = await comp.fun(msg, send, safeDone);
                sendResults(send, msg._msgid, outputs);
                safeDone();
            } catch (error: any) {
                safeDone(error);
            }
        });
        
        // Clean up compilation on node close
        this.on('close', async () => {
            try {
                if (this.comp) await this.comp.fin();
            } catch (error: any) {
                this.error('Error in function finalize: ' + (error.stack || error.message));
            }

            if ((this as any).clearStatus) this.status({});

            this.timeouts.forEach(clearTimeout);
            this.timeouts.clear();

            this.intervals.forEach(clearInterval);
            this.intervals.clear();

            delete this.comp;
        });
    };
    
    (RED.nodes.registerType as any)("typescript", TypeScriptNode, {
        dynamicModuleList: "libs",
        settings: {
            functionExternalModules: {
                value: true,
                exportable: true
            },
            functionTimeout: {
                value:0,
                exportable: true
            }
        }
    });
};
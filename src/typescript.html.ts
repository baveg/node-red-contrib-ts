declare const RED: any;
declare const window: typeof globalThis & {
    monaco: any;
    tsConfigured: any;
    currentNodeInstance: any;
};

function tr(key: string, params?: Record<string, string | number>) {
    var result = RED._("node-red:" + key);
    if (params) {
        for (var k in params) {
            result = result.replace("{" + k + "}", params[k]);
        }
    }
    return result;
}

function getLabel(this: any) {
    if (this.name) return this.name;

    let script = this.func || "";
    for (
        const [key, label] of Object.entries({
            "fetch(": "🌐 Fetch",
            "fs.": "📁 File",
            "crypto.": "🔐 Crypto",
            "setTimeout": "⏰ Timer",
            "setInterval": "🔄 Loop",
            "process.": "⚙️ Process",
            "JSON.": "📄 JSON",
            "Buffer": "🔢 Buffer",
        })
    ) {
        if (script.includes(key)) return label;
    }

    // Extract keywords, limit to 20 chars
    const e = {
        const: 1,
        let: 1,
        var: 1,
        msg: 1,
        payload: 1,
        as: 1,
        any: 1,
        string: 1,
        number: 1,
        return: 1,
        null: 1,
    };
    let s = "";
    const ws = script.toLowerCase().match(/\w\w+/g) || [];
    for (let w of ws) {
        if (!e[w]) {
            e[w] = 1;
            const n = s ? s + " " + w : w;
            if (n.length <= 20) s = n;
            else break;
        }
    }
    if (s) return s;

    return "typescript";
}

function throwRequired(msg: string) {
    throw new Error(msg + " is required");
}

const customDelarePath = 'file:///custom-declare.d.ts'
function configMonaco(editor: any, customDeclare: any, nodeLibs?: any[]) {
    const monaco = window.monaco || throwRequired("monaco");
    const languages = monaco.languages || throwRequired("languages");
    const tsLanguage = languages.typescript || throwRequired("tsLanguage");
    const tsEditor = editor || throwRequired("tsEditor");
    const tsConfig = tsLanguage.typescriptDefaults || throwRequired("tsConfig");
    const jsConfig = tsLanguage.javascriptDefaults || throwRequired("jsConfig");

    // Add ExtraLibs From JS loaded by extraLibs options in RED.editor.createEditor function
    // in node-red-master/packages/node_modules/@node-red/editor-client/src/js/ui/editors/code-editors/monaco.js)
    const extraLibs = jsConfig.getExtraLibs();
    Object.entries(extraLibs).forEach(([uri, lib]: any) => {
        if (lib && lib.content) {
            tsConfig.addExtraLib(lib.content, uri);
        }
    });

    // Generate module declarations based on node's lib list
    const generateModuleDeclarations = (libs?: any[]): string => {
        if (!libs || libs.length === 0) return '';
        
        return libs.map(lib => {
            const varName = lib.var;
            const moduleName = lib.module;
            return `declare const ${varName}: typeof import('${moduleName}');`;
        }).join('\n');
    };

    // Add Node-RED global types
    const nodeRedTypes = `
/// <reference lib="es2022" />
/// <reference lib="dom" />
/// <reference types="node" />

declare const require: NodeRequire;
declare const util: typeof import('util');

${generateModuleDeclarations(nodeLibs)}

declare const RED: {
    util: {
        getSetting: (node: any, key: string) => any;
    };
};
declare const context: {
    get: (key: string, store?: string) => any;
    set: (key: string, value: any, store?: string) => void;
    flow: any;
    global: any;
};
declare const flow: {
    get: <T = any>(key: string) => T;
    set: (key: string, value: any) => void;
};
declare const global: any;
declare const env: {
    get: (key: string) => any;
};
`;

    tsConfig.addExtraLib(nodeRedTypes, "file:///node-red-types.d.ts");
    tsConfig.addExtraLib(customDeclare ?? '', customDelarePath);

    // Only configure once per session
    if (!window.tsConfigured) {
        tsConfig.setDiagnosticsOptions({
            noSemanticValidation: false,
            noSyntaxValidation: false,
            noSuggestionDiagnostics: false,
            diagnosticCodesToIgnore: [
                2451, // Cannot redeclare block-scoped variable 'msg'.
                1375, // 'await' expressions are only allowed at the top level of a file when that file is a module
                1378, // Top-level 'await' expressions are only allowed when the 'module' option is set to 'es2022'
                1108, // A 'return' statement can only be used within a function body
                // Removed 2339 to allow property errors to show
            ],
        });

        tsConfig.setCompilerOptions({
            target: tsLanguage.ScriptTarget.ES2022,
            module: tsLanguage.ModuleKind.NodeNext,
            moduleResolution:
                monaco.languages.typescript.ModuleResolutionKind.NodeNext,
            types: ["node"],
            allowJs: true,
            lib: ["ES2022", "ES2022.String", "ES2022.Array", "ES2022.Object"],
            skipLibCheck: true,
            esModuleInterop: true,
            allowSyntheticDefaultImports: true,
            noImplicitAny: false,
            strict: false,
            strictNullChecks: false,
            suppressImplicitAnyIndexErrors: true,
            strictPropertyInitialization: false,
            noImplicitReturns: false,
            noImplicitThis: false,
        });
        window.tsConfigured = true;
    }

    // Configure individual editor model
    const tsModel = tsEditor.getModel();
    if (tsModel) {
        if (
            !tsModel.uri.path.endsWith(".ts") ||
            tsModel.getLanguageId() !== "typescript"
        ) {
            // Generate unique URI for this editor
            const uniqueId = tsEditor.getId
                ? tsEditor.getId()
                : Math.random().toString(36).substr(2, 9);
            const tsUri = monaco.Uri.parse(`file:///ts-${uniqueId}.ts`);

            // Check if model already exists with this URI
            let existingModel = monaco.editor.getModel(tsUri);
            if (existingModel) {
                tsEditor.setModel(existingModel);
            } else {
                const newModel = monaco.editor.createModel(
                    tsModel.getValue(),
                    "typescript",
                    tsUri,
                );
                tsEditor.setModel(newModel);
            }
        } else {
            // Force language to typescript if not already set
            if (tsModel.getLanguageId() !== "typescript") {
                monaco.editor.setModelLanguage(tsModel, "typescript");
            }
        }
    } else {
        console.warn("[TS] configMonaco no model found on editor");
    }
}

function onTsEditorReady(editor: any) {
    if (editor.type === "monaco") {

        // Get current declarations from the node instance
        let customDeclare = null;
        if (
            window.currentNodeInstance &&
            window.currentNodeInstance.declareEditor
        ) {
            customDeclare = window.currentNodeInstance.declareEditor.getValue();
        }

        try {
            // Get current node's libs for dynamic module declarations
            const nodeLibs = window.currentNodeInstance ? getLibsList() : [];
            configMonaco(editor, customDeclare, nodeLibs);

            // Verify configuration
            const model = editor.getModel();
            if (!model) {
                console.warn(
                    "[TS] configTsEditor verification failed - no model found",
                );
            }
        } catch (error) {
            console.error(
                "[TS] configTsEditor Monaco configuration error:",
                error,
            );
        }
    } else {
        console.warn(
            "[TS] configTsEditor editor type is not Monaco:",
            editor.type,
        );
    }
}

function configTsEditor(options: any, that: any) {
    const tsOptions = {
        ...options,
        mode: "ace/mode/typescript",
        language: "typescript",
        globals: {
            msg: true,
            node: true,
            context: true,
            RED: true,
            flow: true,
            global: true,
            env: true,
            console: true,
            Buffer: true,
            process: true,
            fetch: true,
            setTimeout: true,
            clearTimeout: true,
            setInterval: true,
            clearInterval: true,
        },
        onready: onTsEditorReady,
    };
    return tsOptions;
}

function setEditor(editor: any) {
    if (editor.type === "monaco") {
        // Fallback to setTimeout since onready callback isn't being triggered
        setTimeout(() => {
            onTsEditorReady(editor);
        }, 100);
    } else {
        console.warn("[TS] setEditor unknown editor type:", editor.type);
    }
}

function resetDeclare(that: any) {
    that.declareEditor.setValue('');
}

const firstLower = (v: string) => v ? v[0].toLowerCase() + v.substring(1) : v;
const firstUpper = (v: string) => v ? v[0].toUpperCase() + v.substring(1) : v;
const getModuleVarName = (v: string) => {
    v = String(v).replace('node:', '');
    if (v === 'fs/promises') return 'fs';
    return firstLower(v.split(/[\W_]+/).map(firstUpper).join(''));
}

var invalidModuleVNames = [
    "console",
    "util",
    "Buffer",
    "Date",
    "RED",
    "node",
    "__node__",
    "context",
    "flow",
    "global",
    "env",
    "setTimeout",
    "clearTimeout",
    "setInterval",
    "clearInterval",
    "promisify",
];

// Simplification : on log juste les erreurs de modules manquants dans la console
RED.events.on("runtime-state", function (event) {
    if (event.error === "missing-modules") {
        event.modules.forEach(function (m) {
            console.error("[TS] Missing module:", m.module, "-", m.error);
        });
    }
});

var installAllowList = ["*"];
var installDenyList = [];

var settingsAllowList = RED.settings.get("externalModules.modules.allowList");
var settingsDenyList = RED.settings.get("externalModules.modules.denyList");
if (settingsAllowList || settingsDenyList) {
    installAllowList = settingsAllowList;
    installDenyList = settingsDenyList;
}
installAllowList = RED.utils.parseModuleList(installAllowList);
installDenyList = RED.utils.parseModuleList(installDenyList);

function getStandardModules(): string[] {
    return [
        "fs/promises",
        "path",
        "os",
        "crypto",
        "process",
        "child_process",
        "zlib",
        // "express",
        // "axios",
        // "lodash",
        // "moment",
        // "uuid",
    ];
}

function prepareLibraryConfig(node: any) {
    $(".node-input-libs-row").show();
    
    // Utilise simplement la liste des modules standards
    const availableModules = getStandardModules();
    
    var typedModules = availableModules.map(name => {
        return {
            icon: "fa fa-cube",
            value: name,
            label: name,
            hasValue: false,
        };
    });
    typedModules.push({
        value: "_custom_",
        label: RED._("editor:subflow.licenseOther"),
        icon: "red/images/typedInput/az.svg",
        hasValue: true,
    });

    var libList = $("#node-input-libs-container").css("min-height", "100px")
        .css("min-width", "450px").editableList({
            header: $(
                '<div><div data-i18n="node-red:function.require.moduleName"></div><div data-i18n="node-red:function.require.importAs"></div></div>',
            ),
            addItem: function (container: any, _i: any, opt: any) {
                var parent = container.parent();
                var row0 = $("<div/>").addClass("node-libs-entry").appendTo(
                    container,
                );
                var fmoduleSpan = $("<span>").appendTo(row0);
                var fmodule = $("<input/>", {
                    class: "node-input-libs-val",
                    placeholder: tr("function.require.module"),
                    type: "text",
                }).css({}).appendTo(fmoduleSpan).typedInput({
                    types: typedModules as any,
                    default: availableModules.includes(opt.module) ? opt.module : "_custom_",
                }) as any;
                if (!availableModules.includes(opt.module)) {
                    fmodule.typedInput("value", opt.module);
                }
                var moduleWarning = $(
                    '<span style="position: absolute;right:2px;top:7px; display:inline-block; width: 16px;"><i class="fa fa-warning"></i></span>',
                ).appendTo(fmoduleSpan);
                RED.popover.tooltip(moduleWarning.find("i"), function () {
                    var val = fmodule.typedInput("type");
                    if (val === "_custom_") {
                        val = fmodule.val();
                    }
                    if (
                        !RED.utils.checkModuleAllowed(
                            val,
                            null,
                            installAllowList,
                            installDenyList,
                        )
                    ) {
                        return tr("function.error.moduleNotAllowed", {
                            module: val,
                        });
                    } else {
                        return "Module may not be installed. Check console for errors.";
                    }
                });

                var fvarSpan = $("<span>").appendTo(row0);

                var fvar = $("<input/>", {
                    class: "node-input-libs-var red-ui-font-code",
                    placeholder: tr("function.require.var"),
                    type: "text",
                }).css({}).appendTo(fvarSpan).val(opt.var) as any;
                var vnameWarning = $(
                    '<span style="position: absolute; right:2px;top:7px;display:inline-block; width: 16px;"><i class="fa fa-warning"></i></span>',
                ).appendTo(fvarSpan);
                RED.popover.tooltip(vnameWarning.find("i"), function () {
                    var val = fvar.val() as string;
                    if (invalidModuleVNames.indexOf(val) !== -1) {
                        return tr("function.error.moduleNameReserved", {
                            name: val,
                        });
                    } else {
                        return tr("function.error.moduleNameError", {
                            name: val,
                        });
                    }
                });

                fvar.on("change keyup paste", function (this: any, e: any) {
                    var v = ($(this).val() as string || "").trim();
                    if (
                        v === "" || / /.test(v) ||
                        invalidModuleVNames.indexOf(v) !== -1
                    ) {
                        fvar.addClass("input-error");
                        vnameWarning.addClass("input-error");
                    } else {
                        fvar.removeClass("input-error");
                        vnameWarning.removeClass("input-error");
                    }
                });

                fmodule.on("change keyup paste", function (this: any, e: any) {
                    var val = $(this).typedInput("type");

                    if (val === "_custom_") {
                        val = $(this).val();
                    }
                    
                    var varName = getModuleVarName(val);
                    
                    fvar.val(varName);
                    fvar.trigger("change");

                    if (
                        RED.utils.checkModuleAllowed(
                            val as string,
                            null,
                            installAllowList as any,
                            installDenyList as any,
                        )
                    ) {
                        fmodule.removeClass("input-error");
                        moduleWarning.removeClass("input-error");
                    } else {
                        fmodule.addClass("input-error");
                        moduleWarning.addClass("input-error");
                    }
                });
                if (
                    RED.utils.checkModuleAllowed(
                        opt.module as string,
                        null,
                        installAllowList as any,
                        installDenyList as any,
                    )
                ) {
                    fmodule.removeClass("input-error");
                    moduleWarning.removeClass("input-error");
                } else {
                    fmodule.addClass("input-error");
                    moduleWarning.addClass("input-error");
                }
                if (opt.var) {
                    fvar.trigger("change");
                }
            },
            removable: true,
        });

    var libs = node.libs || [];
    for (var i = 0, l = libs.length; i < l; i++) {
        libList.editableList("addItem", libs[i]);
    }
}

function getLibsList() {
    var _libs = [];
    if (RED.settings.functionExternalModules !== false) {
        var libs = $("#node-input-libs-container").editableList("items");
        libs.each(function (i) {
            var item = $(this);
            var v = item.find(".node-input-libs-var").val() as string;
            var n = item.find(".node-input-libs-val").typedInput("type");
            if (n === "_custom_") {
                n = item.find(".node-input-libs-val").val() as string;
            }
            if (
                (!v || (v === "")) ||
                (!n || (n === ""))
            ) {
                return;
            }
            (_libs as any).push({
                var: v,
                module: n as string,
            });
        });
    }
    return _libs;
}

function removeExtraLib(filePath: string) {
    const monaco = window.monaco;
    if (!monaco) throw new Error("monaco not found");

    const tsConfig = monaco.languages.typescript.typescriptDefaults;

    // 1️⃣ 删除 editor model（如果存在）
    const uri = monaco.Uri.parse(filePath);
    const model = monaco.editor.getModel(uri);
    if (model) model.dispose();

    // 2️⃣ 删除 extraLib
    const currentLibs: Record<string, any> = tsConfig.getExtraLibs();
    const newLibsArray = Object.entries(currentLibs)
        .filter(([path]) => path !== filePath)
        .map(([path, lib]) => ({
            filePath: path,
            content: lib.content
        }));

    // 3️⃣ 覆盖到 tsConfig
    tsConfig.setExtraLibs(newLibsArray);
}

RED.nodes.registerType("typescript", {
    color: "#61adff",
    category: "function",
    paletteLabel: "typescript",
    defaults: {
        name: { value: "_DEFAULT_" },
        func: { value: "\nreturn msg;" },
        outputs: { value: 1 },
        timeout: { value: RED.settings.functionTimeout || 0 },
        useVm: { value: false },
        updated: { value: 0 },
        declare: { value: "" },
        noerr: {
            value: 0,
            required: true,
            validate: function (v: any, opt: any) {
                if (!v) {
                    return true;
                }
                return tr("function.error.invalid-js");
            },
        },
        initialize: { value: "" },
        finalize: { value: "" },
        libs: {
            value: [],
            validate: function (v: any, opt: any) {
                if (!v) return true;
                for (var i = 0, l = v.length; i < l; i++) {
                    var m = v[i];
                    if (
                        !RED.utils.checkModuleAllowed(
                            m.module,
                            null,
                            installAllowList,
                            installDenyList,
                        )
                    ) {
                        return tr("function.error.moduleNotAllowed", {
                            module: m.module,
                        });
                    }
                    if (m.var === "" || / /.test(m.var)) {
                        return tr("function.error.moduleNameError", {
                            name: m.var,
                        });
                    }
                    // Simplification : plus de validation des modules manquants ici
                    // Les erreurs sont loggées dans la console via runtime-state
                    if (invalidModuleVNames.indexOf(m.var) !== -1) {
                        return tr("function.error.moduleNameError", {
                            name: m.var,
                        });
                    }
                }
                return true;
            },
        },
    },
    inputs: 1,
    outputs: 1,
    icon: "typescript.svg",
    label: getLabel,
    labelStyle: function (this: any) {
        return this.name ? "node_label_italic" : "";
    },
    oneditprepare: function (this: any) {
        var that = this;
        window.currentNodeInstance = this;

        var tabs = RED.tabs.create({
            id: "func-tabs",
            onchange: function (tab: any) {
                $("#func-tabs-content").children().hide();
                $("#" + tab.id).show();
                let editor = $("#" + tab.id).find(".monaco-editor").first();
                if (editor.length) {
                    if (that.editor.nodered && that.editor.type == "monaco") {
                        that.editor.nodered.refreshModuleLibs(getLibsList());
                        
                        // Also refresh TypeScript configuration for all editors
                        try {
                            const customDeclare = that.declareEditor ? that.declareEditor.getValue() : null;
                            const nodeLibs = getLibsList();
                            
                            // Refresh all Monaco editors
                            [that.editor, that.initEditor, that.finalizeEditor].forEach(editor => {
                                if (editor && editor.type === "monaco") {
                                    configMonaco(editor, customDeclare, nodeLibs);
                                }
                            });
                        } catch (error) {
                            console.warn("[TS] Failed to refresh Monaco TypeScript on tab change:", error);
                        }
                    }
                    RED.tray.resize();
                    //auto focus editor on tab switch
                    if (that.initEditor.getDomNode() == editor[0]) {
                        that.initEditor.focus();
                    } else if (that.editor.getDomNode() == editor[0]) {
                        that.editor.focus();
                    } else if (that.finalizeEditor.getDomNode() == editor[0]) {
                        that.finalizeEditor.focus();
                    } else if (that.declareEditor.getDomNode() === editor[0]) {
                        console.debug('hack declare editor error')
                        removeExtraLib(customDelarePath)
                    }
                }
            },
        });
        tabs.addTab({
            id: "func-tab-config",
            iconClass: "fa fa-cog",
            label: tr("function.label.setup"),
        });

        tabs.addTab({
            id: "func-tab-init",
            label: tr("function.label.initialize"),
        });
        tabs.addTab({
            id: "func-tab-body",
            label: tr("function.label.function"),
        });
        tabs.addTab({
            id: "func-tab-finalize",
            label: tr("function.label.finalize"),
        });

        tabs.activateTab("func-tab-body");

        ($("#node-input-outputs") as any).spinner({
            min: 0,
            max: 500,
            change: function (this: any, _event: any, _ui: any) {
                var value = parseInt(this.value);
                value = isNaN(value) ? 1 : value;
                value = Math.max(
                    value,
                    parseInt($(this).attr("aria-valuemin") || "0"),
                );
                value = Math.min(
                    value,
                    parseInt($(this).attr("aria-valuemax") || "500"),
                );
                if (value !== this.value) {
                    ($(this) as any).spinner("value", value);
                }
            },
        });

        // 4294967 is max in node.js timeout.
        ($("#node-input-timeout") as any).spinner({
            min: 0,
            max: 4294967,
            change: function (this: any, event: any, ui: any) {
                var value = this.value;
                if (value == "") {
                    value = 0;
                } else {
                    value = parseInt(value);
                }
                value = isNaN(value) ? 1 : value;
                value = Math.max(
                    value,
                    parseInt($(this).attr("aria-valuemin") || "0"),
                );
                value = Math.min(
                    value,
                    parseInt($(this).attr("aria-valuemax") || "4294967"),
                );
                if (value !== this.value) {
                    ($(this) as any).spinner("value", value);
                }
            },
        });

        var buildEditor = function (
            id: any,
            stateId: any,
            _focus: any,
            value: any,
            defaultValue: any,
            extraLibs: any,
            offset: any,
        ) {
            var editor = RED.editor.createEditor(configTsEditor({
                id: id,
                value: value || defaultValue || "",
                stateId: stateId,
                focus: true,
                extraLibs: extraLibs,
            }, that));
            if (defaultValue && value === "") {
                editor.moveCursorTo(
                    defaultValue.split("\n").length + offset,
                    0,
                );
            }
            editor.__stateId = stateId;
            setEditor(editor);
            return editor;
        };
        this.initEditor = buildEditor(
            "node-input-init-editor",
            this.id + "/" + "initEditor",
            false,
            $("#node-input-initialize").val(),
            tr("function.text.initialize"),
            undefined,
            0,
        );
        this.editor = buildEditor(
            "node-input-func-editor",
            this.id + "/" + "editor",
            true,
            $("#node-input-func").val(),
            undefined,
            that.libs || [],
            -1,
        );
        this.finalizeEditor = buildEditor(
            "node-input-finalize-editor",
            this.id + "/" + "finalizeEditor",
            false,
            $("#node-input-finalize").val(),
            tr("function.text.finalize"),
            undefined,
            0,
        );
        this.declareEditor = buildEditor(
            "node-input-declare-editor",
            this.id + "/" + "declareEditor",
            false,
            this.declare,
            undefined,
            undefined,
            0,
        );

        RED.library.create({
            url: "functions", // where to get the data from
            type: "function", // the type of object the library is for
            editor: this.editor, // the field name the main text body goes to
            mode: "ace/mode/nrjavascript",
            fields: [
                "name",
                "outputs",
                "timeout",
                {
                    name: "initialize",
                    get: function () {
                        return that.initEditor.getValue();
                    },
                    set: function (v) {
                        that.initEditor.setValue(
                            v || tr("function.text.initialize"),
                            -1,
                        );
                    },
                },
                {
                    name: "finalize",
                    get: function () {
                        return that.finalizeEditor.getValue();
                    },
                    set: function (v) {
                        that.finalizeEditor.setValue(
                            v || tr("function.text.finalize"),
                            -1,
                        );
                    },
                },
                {
                    name: "info",
                    get: function () {
                        return that.infoEditor.getValue();
                    },
                    set: function (v) {
                        that.infoEditor.setValue(v || "", -1);
                    },
                },
            ],
            ext: "js",
        });

        var expandButtonClickHandler = function (editor) {
            return function (e) {
                e.preventDefault();
                var value = editor.getValue();
                editor.saveView(
                    `inside function-expandButtonClickHandler ${editor.__stateId}`,
                );
                var extraLibs = that.libs || [];
                RED.editor.editJavaScript(configTsEditor({
                    value: value,
                    width: "Infinity",
                    stateId: editor.__stateId,
                    focus: true,
                    cancel: function () {
                        setTimeout(function () {
                            editor.focus();
                        }, 250);
                    },
                    complete: function (v, _cursor) {
                        editor.setValue(v, -1);
                        setTimeout(function () {
                            editor.restoreView();
                            editor.focus();
                        }, 250);
                    },
                    extraLibs: extraLibs,
                }, that));
            };
        };
        $("#node-init-expand-js").on(
            "click",
            expandButtonClickHandler(this.initEditor),
        );
        $("#node-function-expand-js").on(
            "click",
            expandButtonClickHandler(this.editor),
        );
        $("#node-finalize-expand-js").on(
            "click",
            expandButtonClickHandler(this.finalizeEditor),
        );
        $("#node-declare-expand-js").on(
            "click",
            expandButtonClickHandler(this.declareEditor),
        );

        RED.popover.tooltip(
            $("#node-init-expand-js"),
            tr("common.label.expand"),
        );
        RED.popover.tooltip(
            $("#node-function-expand-js"),
            tr("common.label.expand"),
        );
        RED.popover.tooltip(
            $("#node-finalize-expand-js"),
            tr("common.label.expand"),
        );
        RED.popover.tooltip(
            $("#node-declare-expand-js"),
            tr("common.label.expand"),
        );
        RED.popover.tooltip($("#node-reset-declare"), "Reset declare types");

        // Auto-detect button handler
        $("#node-reset-declare").on("click", function () {
            resetDeclare(that);
        });

        if (RED.settings.functionExternalModules !== false) {
            prepareLibraryConfig(that);

            // Add default modules button logic
            $("#node-add-default-modules").on("click", function () {
                var libList = $("#node-input-libs-container");
                getStandardModules().forEach((name) => {
                    libList.editableList("addItem", {
                        var: getModuleVarName(name),
                        module: name
                    });
                });
            });
        }
    },
    oneditsave: function (this: any) {
        var node = this;
        var noerr = 0;
        $("#node-input-noerr").val(0);

        // Transfer old script property to func for backward compatibility
        if (this.script && !this.func) {
            this.func = this.script;
            delete this.script;
        }

        // Update timestamp to invalidate compilation cache
        $("#node-input-updated").val(Date.now());

        var disposeEditor = function (
            editorName: string,
            targetName: string,
            defaultValue?: string,
        ) {
            var editor = node[editorName];
            console.debug('hack validate error')
            if (editorName !== 'declareEditor') {
                var annot = editor.getSession().getAnnotations();
                for (var k = 0; k < annot.length; k++) {
                    if (annot[k].type === "error") {
                        noerr += annot.length;
                        break;
                    }
                }
            }
            var val = editor.getValue();
            if (defaultValue) {
                if (val.trim() == defaultValue.trim()) {
                    val = "";
                }
            }
            editor.destroy();
            delete node[editorName];
            $("#" + targetName).val(val);
        };
        disposeEditor("editor", "node-input-func");
        disposeEditor(
            "initEditor",
            "node-input-initialize",
            tr("function.text.initialize"),
        );
        disposeEditor(
            "finalizeEditor",
            "node-input-finalize",
            tr("function.text.finalize"),
        );
        disposeEditor("declareEditor", "node-input-declare");

        $("#node-input-noerr").val(noerr);
        this.noerr = noerr;
        node.libs = getLibsList();
    },
    oneditcancel: function (this: any) {
        var node = this;

        node.editor.destroy();
        delete node.editor;

        node.initEditor.destroy();
        delete node.initEditor;

        node.finalizeEditor.destroy();
        delete node.finalizeEditor;

        node.declareEditor.destroy();
        delete node.declareEditor;
    },
    oneditresize: function (this: any, size: any) {
        var rows = $("#dialog-form>div:not(.node-text-editor-row)");
        var height = $("#dialog-form").height() || 0;
        for (var i = 0; i < rows.length; i++) {
            height -= $(rows[i]).outerHeight(true) || 0;
        }
        var editorRow = $("#dialog-form>div.node-text-editor-row");
        height -= parseInt(editorRow.css("marginTop") || "0") +
            parseInt(editorRow.css("marginBottom") || "0");
        $("#dialog-form .node-text-editor").css("height", height + "px");

        var sizeHeight = size.height || 0;
        $("#node-input-init-editor").css("height", (sizeHeight - 75) + "px");
        $("#node-input-func-editor").css("height", (sizeHeight - 75) + "px");
        $("#node-input-finalize-editor").css(
            "height",
            (sizeHeight - 75) + "px",
        );

        this.initEditor.resize();
        this.editor.resize();
        this.finalizeEditor.resize();

        if (this.declareEditor) {
            this.declareEditor.resize();
        }

        $("#node-input-libs-container").css(
            "height",
            (sizeHeight - 330) + "px",
        );
    },
    onadd: function (this: any) {
        if (this.name === "_DEFAULT_") {
            this.name = "";
            RED.actions.invoke("core:generate-node-names", this, {
                generateHistory: false,
            });
        }
    },
});

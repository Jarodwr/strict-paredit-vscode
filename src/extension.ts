'use strict';
import { StatusBar } from './status_bar';
import * as utils from './utils';
import { commands, window, ExtensionContext, workspace, ConfigurationChangeEvent, } from 'vscode';

let paredit = require('paredit.js');

const languages = new Set(["commonlisp", "clojure", "lisp", "scheme", "fennel"]);
let enabled = true,
    expandState = { range: null, prev: null };

const navigate = (fn, opts = {}) =>
    ({ textEditor, ast, selection }) => {
        let res = fn(ast, selection.cursor);
        if (res == selection.cursor && opts["_unlessMoved"]) {
            opts["_unlessMoved"]({ textEditor, ast, selection });
        }
        utils.select(textEditor, res);
    }

const yank = (fn, ...args) =>
    ({ textEditor, ast, selection }) => {
        let res = fn(ast, selection.cursor, ...args),
            positions = typeof (res) === "number" ? [selection.cursor, res] : res;
        utils.copy(textEditor, positions);
    }

const cut = (fn, ...args) =>
    ({ textEditor, ast, selection }) => {
        let res = fn(ast, selection.cursor, ...args),
            positions = typeof (res) === "number" ? [selection.cursor, res] : res;
        utils.cut(textEditor, positions);
    }

const navigateExpandSelecion = (fn, ...args) =>
    ({ textEditor, ast, selection }) => {
        let range = textEditor.selection,
            res = fn(ast, selection.start, selection.end, ...args);
        if (expandState.prev == null || !range.contains(expandState.prev.range)) {
            expandState = { range: range, prev: null };
        }
        expandState = { range: utils.select(textEditor, res), prev: expandState };
    }

function navigateContractSelecion({ textEditor, selection }) {
    let range = textEditor.selection;
    if (expandState.prev && expandState.prev.range && range.contains(expandState.prev.range)) {
        textEditor.selection = expandState.prev.range;
        expandState = expandState.prev;
    }
}

function indent({ textEditor, selection }) {
    let src = textEditor.document.getText(),
        ast = paredit.parse(src),
        res = paredit.editor.indentRange(ast, src, selection.start, selection.end);

    utils
        .edit(textEditor, utils.commands(res))
        .then((applied?) => utils.undoStop(textEditor));
}

function leftChar({ textEditor, selection }) {
    commands.executeCommand('cursorMove', { to: "left" })
}

function rightChar({ textEditor, selection }) {
    commands.executeCommand('cursorMove', { to: "right" })
}

const wrapAround = (ast, src, start, { opening, closing }) => paredit.editor.wrapAround(ast, src, start, opening, closing);

const edit = (fn, opts = {}) =>
    ({ textEditor, src, ast, selection }) => {
        let { start, end } = selection;
        let res = fn(ast, src, selection.start, { ...opts, endIdx: start === end ? undefined : end });

        if (res)
            if (res.changes.length > 0) {
                if (fn == paredit.editor.delete) {
                    // Use VSCode's delete to delete indent if any
                    if (opts['backward']) {
                        commands.executeCommand("deleteLeft")
                    } else {
                        commands.executeCommand("deleteRight")
                    }
                    return
                }
                let cmd = utils.commands(res),
                    sel = {
                        start: Math.min(...cmd.map(c => c.start)),
                        end: Math.max(...cmd.map(utils.end))
                    };

                utils
                    .edit(textEditor, cmd)
                    .then((applied?) => {
                        utils.select(textEditor, res.newIndex);
                    });
            }
            else {
                if (opts["_unlessApplied"]) {
                    opts["_unlessApplied"]({ textEditor, selection });
                }
                utils.select(textEditor, res.newIndex);
            }
    }

const createNavigationCopyCutCommands = (commands) => {
    const capitalizeFirstLetter = (s) => { return s.charAt(0).toUpperCase() + s.slice(1); }

    let result: [string, Function][] = new Array<[string, Function]>();
    Object.keys(commands).forEach((c) => {
        result.push([`paredit.${c}`, navigate(commands[c][0], commands[c][1])]);
        result.push([`paredit.yank${capitalizeFirstLetter(c)}`, yank(commands[c][0])]);
        result.push([`paredit.cut${capitalizeFirstLetter(c)}`, cut(commands[c][0])]);
    });
    return result;
}

const navCopyCutcommands = {
    'rangeForDefun': [paredit.navigator.rangeForDefun, {}],
    'forwardSexp': [paredit.navigator.forwardSexp, { '_unlessMoved': rightChar }],
    'backwardSexp': [paredit.navigator.backwardSexp, { '_unlessMoved': leftChar }],
    'forwardDownSexp': [paredit.navigator.forwardDownSexp, {}],
    'backwardUpSexp': [paredit.navigator.backwardUpSexp, {}],
    'closeList': [paredit.navigator.closeList, {}],
    'closeList2': [paredit.navigator.closeList, {}]
};

const pareditCommands: [string, Function][] = [

    // SELECTING
    ['paredit.sexpRangeExpansion', navigateExpandSelecion(paredit.navigator.sexpRangeExpansion)],
    ['paredit.sexpRangeContraction', navigateContractSelecion],

    // NAVIGATION, COPY, CUT
    // (Happens in createNavigationCopyCutCommands())

    // EDITING
    ['paredit.openList', edit(paredit.editor.openList)],
    ['paredit.slurpSexpForward', edit(paredit.editor.slurpSexp, { 'backward': false })],
    ['paredit.slurpSexpBackward', edit(paredit.editor.slurpSexp, { 'backward': true })],
    ['paredit.barfSexpForward', edit(paredit.editor.barfSexp, { 'backward': false })],
    ['paredit.barfSexpBackward', edit(paredit.editor.barfSexp, { 'backward': true })],
    ['paredit.spliceSexp', edit(paredit.editor.spliceSexp)],
    ['paredit.splitSexp', edit(paredit.editor.splitSexp)],
    ['paredit.killSexpForward', edit(paredit.editor.killSexp, { 'backward': false })],
    ['paredit.killSexpBackward', edit(paredit.editor.killSexp, { 'backward': true })],
    ['paredit.spliceSexpKillForward', edit(paredit.editor.spliceSexpKill, { 'backward': false })],
    ['paredit.spliceSexpKillBackward', edit(paredit.editor.spliceSexpKill, { 'backward': true })],
    ['paredit.deleteForward', edit(paredit.editor.delete, { 'backward': false, '_unlessApplied': rightChar })],
    ['paredit.deleteBackward', edit(paredit.editor.delete, { 'backward': true, '_unlessApplied': leftChar })],
    ['paredit.wrapAroundParens', edit(wrapAround, { opening: '(', closing: ')' })],
    ['paredit.wrapAroundSquare', edit(wrapAround, { opening: '[', closing: ']' })],
    ['paredit.wrapAroundCurly', edit(wrapAround, { opening: '{', closing: '}' })],
    ['paredit.indentRange', indent],
    ['paredit.transpose', edit(paredit.editor.transpose)]];

function wrapPareditCommand(fn) {
    return () => {

        let textEditor = window.activeTextEditor;
        let doc = textEditor.document;
        if (!enabled || !languages.has(doc.languageId)) return;

        let src = textEditor.document.getText();
        fn({
            textEditor: textEditor,
            src: src,
            ast: paredit.parse(src),
            selection: utils.getSelection(textEditor)
        });
    }
}

function setKeyMapConf() {
    let keyMap = workspace.getConfiguration().get('paredit.defaultKeyMap');
    commands.executeCommand('setContext', 'paredit:keyMap', keyMap);
}
setKeyMapConf();

export function activate(context: ExtensionContext) {

    let statusBar = new StatusBar();

    context.subscriptions.push(
        statusBar,
        commands.registerCommand('paredit.toggle', () => { enabled = !enabled; statusBar.enabled = enabled; }),
        window.onDidChangeActiveTextEditor((e) => statusBar.visible = e && e.document && languages.has(e.document.languageId)),
        workspace.onDidChangeConfiguration((e: ConfigurationChangeEvent) => {
            console.log(e);
            if (e.affectsConfiguration('paredit.defaultKeyMap')) {
                setKeyMapConf();
            }
        }),

        ...createNavigationCopyCutCommands(navCopyCutcommands)
            .map(([command, fn]) => commands.registerCommand(command, wrapPareditCommand(fn))),
        ...pareditCommands
            .map(([command, fn]) => commands.registerCommand(command, wrapPareditCommand(fn))));
}
export function deactivate() {
}

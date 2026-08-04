import fs from "node:fs/promises";
import type { Stats } from "node:fs";
import path from "node:path";
import { URL } from "node:url";
import { isUnderDir, normalizeMapKey, pathsEqual, uriToPath } from "./path-utils.js";
import {
	convertCharacterOffset,
	lineTextAt,
	type PositionEncoding,
} from "./position-encoding.js";
import {
	recordLspMutation,
	type LspMutationContext,
} from "../lsp-mutation.js";

export interface LSPPosition {
	line: number;
	character: number;
}

export interface LSPRange {
	start: LSPPosition;
	end: LSPPosition;
}

export interface LSPTextEdit {
	range: LSPRange;
	newText: string;
}

interface TextDocumentEdit {
	textDocument: { uri: string; version?: number | null };
	edits: unknown[];
}

interface ResourceOptions {
	overwrite?: boolean;
	ignoreIfExists?: boolean;
	ignoreIfNotExists?: boolean;
	recursive?: boolean;
}

interface CreateFileOp {
	kind: "create";
	uri: string;
	options?: ResourceOptions;
}

interface RenameFileOp {
	kind: "rename";
	oldUri: string;
	newUri: string;
	options?: ResourceOptions;
}

interface DeleteFileOp {
	kind: "delete";
	uri: string;
	options?: ResourceOptions;
}

export interface AppliedWorkspaceFileDetail {
	filePath: string;
	range?: { start: number; end: number };
	importsChanged?: boolean;
}

export interface AppliedWorkspaceEdit {
	descriptions: string[];
	files: string[];
	/** Total logical operations, including text edits and resource operations. */
	operationTotal: number;
	/** Number of logical operations that actually reached disk. */
	appliedOperationTotal: number;
	/** Bounded samples; totals above remain explicit in the result. */
	appliedOperationIndexes: number[];
	operationCounts: {
		textEdits: number;
		create: number;
		rename: number;
		delete: number;
	};
	fileDetails: AppliedWorkspaceFileDetail[];
}

export interface ApplyWorkspaceEditOptions {
	/** The encoding used by the server that produced these positions. */
	positionEncoding?: PositionEncoding;
	/** Current client-side LSP document versions, keyed by normalized path. */
	documentVersions?: ReadonlyMap<string, number>;
	/** Optional shared bookkeeping for a mutation initiated by pi-lens. */
	mutationContext?: LspMutationContext;
	/** Rename flows use one outer bookkeeping record after their resource rename. */
	observe?: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isPosition(value: unknown): value is LSPPosition {
	return (
		isRecord(value) &&
	Number.isFinite(value.line) &&
	Number.isInteger(value.line) &&
	(value.line as number) >= 0 &&
	Number.isFinite(value.character) &&
	Number.isInteger(value.character) &&
	(value.character as number) >= 0
	);
}

function comparePosition(a: LSPPosition, b: LSPPosition): number {
	return a.line === b.line ? a.character - b.character : a.line - b.line;
}

function isRange(value: unknown): value is LSPRange {
	if (!isRecord(value) || !isPosition(value.start) || !isPosition(value.end)) {
		return false;
	}
	return comparePosition(value.start, value.end) <= 0;
}

function isTextEdit(value: unknown): value is LSPTextEdit {
	return isRecord(value) && isRange(value.range) && typeof value.newText === "string";
}

function parseTextEdits(value: unknown, context: string): LSPTextEdit[] {
	if (!Array.isArray(value)) throw new Error(`${context}.edits must be an array`);
	if (!value.every(isTextEdit)) throw new Error(`malformed text edit in ${context}`);
	return value;
}

function parseVersion(value: unknown, context: string): number | null | undefined {
	if (value === undefined || value === null) return value;
	if (!Number.isFinite(value) || !Number.isInteger(value) || (value as number) < 0) {
		throw new Error(`${context}.version must be a nonnegative integer or null`);
	}
	return value as number;
}

function parseResourceOptions(value: unknown, kind: string): ResourceOptions | undefined {
	if (value === undefined) return undefined;
	if (!isRecord(value)) throw new Error(`${kind}.options must be an object`);
	const allowed = new Set(
		kind === "delete"
			? ["ignoreIfNotExists", "recursive"]
			: ["overwrite", "ignoreIfExists"],
	);
	for (const key of Object.keys(value)) {
		if (!allowed.has(key) || typeof value[key] !== "boolean") {
			throw new Error(`invalid ${kind}.options.${key}`);
		}
	}
	if (value.overwrite === true && value.ignoreIfExists === true) {
		throw new Error(`${kind} cannot set both overwrite and ignoreIfExists`);
	}
	if (kind !== "delete" && value.ignoreIfNotExists !== undefined) {
		throw new Error(`${kind} does not support ignoreIfNotExists`);
	}
	if (kind === "delete" && value.overwrite !== undefined) {
		throw new Error(`delete does not support overwrite`);
	}
	return value as ResourceOptions;
}

function parseTextDocumentEdit(value: unknown, context: string): TextDocumentEdit | null {
	if (!isRecord(value) || !isRecord(value.textDocument)) return null;
	if (typeof value.textDocument.uri !== "string") {
		throw new Error(`${context}.textDocument.uri must be a string`);
	}
	const version = parseVersion(value.textDocument.version, `${context}.textDocument`);
	return {
		textDocument: { uri: value.textDocument.uri, version },
		edits: parseTextEdits(value.edits, context),
	};
}

function parseWorkspaceEdit(edit: {
	changes?: Record<string, unknown[]>;
	documentChanges?: unknown[];
}): void {
	if (!isRecord(edit)) throw new Error("workspace edit must be an object");
	if (edit.changes !== undefined) {
		if (!isRecord(edit.changes)) throw new Error("workspace edit changes must be an object");
		for (const [uri, edits] of Object.entries(edit.changes)) {
			if (typeof uri !== "string") throw new Error("workspace edit URI must be a string");
			parseTextEdits(edits, `changes[${uri}]`);
		}
	}
	if (edit.documentChanges !== undefined && !Array.isArray(edit.documentChanges)) {
		throw new Error("workspace edit documentChanges must be an array");
	}
	for (const [index, change] of (edit.documentChanges ?? []).entries()) {
		const text = parseTextDocumentEdit(change, `documentChanges[${index}]`);
		if (text) continue;
		if (!isRecord(change) || typeof change.kind !== "string") {
			throw new Error(`malformed documentChanges[${index}]`);
		}
		switch (change.kind) {
			case "create":
				if (typeof change.uri !== "string") throw new Error("create.uri must be a string");
				parseResourceOptions(change.options, "create");
				break;
			case "rename":
				if (typeof change.oldUri !== "string" || typeof change.newUri !== "string") {
					throw new Error("rename requires oldUri and newUri strings");
				}
				parseResourceOptions(change.options, "rename");
				break;
			case "delete":
				if (typeof change.uri !== "string") throw new Error("delete.uri must be a string");
				parseResourceOptions(change.options, "delete");
				break;
			default:
				throw new Error(`unsupported workspace resource operation: ${change.kind}`);
		}
	}
}

function formatRange(range: LSPRange): string {
	return `${range.start.line + 1}:${range.start.character + 1}-${range.end.line + 1}:${range.end.character + 1}`;
}

export function rangesOverlap(a: LSPRange, b: LSPRange): boolean {
	return comparePosition(a.start, b.end) < 0 && comparePosition(b.start, a.end) < 0;
}

function positionsEqual(a: LSPPosition, b: LSPPosition): boolean {
	return a.line === b.line && a.character === b.character;
}

function rangesEqual(a: LSPRange, b: LSPRange): boolean {
	return positionsEqual(a.start, b.start) && positionsEqual(a.end, b.end);
}

function isEmptyRange(range: LSPRange): boolean {
	return positionsEqual(range.start, range.end);
}

function sortAndValidateTextEdits(edits: LSPTextEdit[]): LSPTextEdit[] {
	const sorted = edits
		.map((edit, index) => ({ edit, index }))
		.sort((a, b) => {
			const positionDelta = comparePosition(b.edit.range.start, a.edit.range.start);
			return positionDelta !== 0 ? positionDelta : b.index - a.index;
		})
		.map(({ edit }) => edit);
	const unique: LSPTextEdit[] = [];
	for (const edit of sorted) {
		const previous = unique[unique.length - 1];
		if (previous && !isEmptyRange(edit.range) && rangesEqual(previous.range, edit.range) && previous.newText === edit.newText) {
			continue;
		}
		unique.push(edit);
	}
	for (let index = 0; index < unique.length - 1; index++) {
		const later = unique[index]?.range;
		const earlier = unique[index + 1]?.range;
		if (later && earlier && comparePosition(earlier.end, later.start) > 0) {
			throw new Error(`overlapping LSP edits: ${formatRange(earlier)} conflicts with ${formatRange(later)}`);
		}
	}
	return unique;
}

function utf16Position(content: string, position: LSPPosition, encoding: PositionEncoding): LSPPosition {
	const line = lineTextAt(content, position.line);
	const wireLength = convertCharacterOffset(encoding, line, line.length);
	if (position.character > wireLength) {
		throw new Error(`text edit character ${position.character} is outside line ${position.line + 1}`);
	}
	if (encoding === "utf-16") return position;
	// Find the UTF-16 offset whose encoded prefix has exactly this length. This
	// rejects offsets in the middle of a UTF-8 sequence or UTF-16 surrogate pair.
	for (let offset = 0; offset <= line.length; offset++) {
		// A UTF-32 position cannot split a UTF-16 surrogate pair.
		if (encoding === "utf-32" && offset > 0 && offset < line.length) {
			const previous = line.charCodeAt(offset - 1);
			const current = line.charCodeAt(offset);
			if (previous >= 0xd800 && previous <= 0xdbff && current >= 0xdc00 && current <= 0xdfff) continue;
		}
		if (convertCharacterOffset(encoding, line, offset) === position.character) {
			return { line: position.line, character: offset };
		}
	}
	throw new Error(`text edit character ${position.character} is not a ${encoding} boundary`);
}

function normalizeTextEditsForContent(content: string, edits: LSPTextEdit[], encoding: PositionEncoding): LSPTextEdit[] {
	const lines = content.split("\n");
	const converted = edits.map((edit) => {
		if (edit.range.start.line >= lines.length || edit.range.end.line >= lines.length) {
			throw new Error(`text edit line is outside the document`);
		}
		const start = utf16Position(content, edit.range.start, encoding);
		const end = utf16Position(content, edit.range.end, encoding);
		if (comparePosition(start, end) > 0) throw new Error("text edit range is out of order");
		return { ...edit, range: { start, end } };
	});
	return sortAndValidateTextEdits(converted);
}

export function applyTextEditsToString(content: string, edits: LSPTextEdit[], positionEncoding: PositionEncoding = "utf-16"): string {
	const lines = content.split("\n");
	for (const edit of normalizeTextEditsForContent(content, edits, positionEncoding)) {
		const { start, end } = edit.range;
		if (start.line === end.line) {
			const line = lines[start.line] ?? "";
			lines[start.line] = line.slice(0, start.character) + edit.newText + line.slice(end.character);
			continue;
		}
		const startLine = lines[start.line] ?? "";
		const endLine = lines[end.line] ?? "";
		const replacement = startLine.slice(0, start.character) + edit.newText + endLine.slice(end.character);
		lines.splice(start.line, end.line - start.line + 1, ...replacement.split("\n"));
	}
	return lines.join("\n");
}

export async function normalizeWorkspaceEditToUtf16(
	edit: { changes?: Record<string, unknown[]>; documentChanges?: unknown[] },
	positionEncoding: PositionEncoding,
): Promise<{ changes?: Record<string, unknown[]>; documentChanges?: unknown[] }> {
	parseWorkspaceEdit(edit);
	if (positionEncoding === "utf-16") return edit;
	const readContent = async (uri: string): Promise<string> => {
		try {
			return await fs.readFile(uriToPath(uri), "utf-8");
		} catch {
			return "";
		}
	};
	const changes: Record<string, unknown[]> = {};
	for (const [uri, rawEdits] of Object.entries(edit.changes ?? {})) {
		const content = await readContent(uri);
		changes[uri] = normalizeTextEditsForContent(content, parseTextEdits(rawEdits, `changes[${uri}]`), positionEncoding);
	}
	const documentChanges: unknown[] = [];
	for (const change of edit.documentChanges ?? []) {
		const text = parseTextDocumentEdit(change, "documentChanges");
		if (!text) {
			documentChanges.push(change);
			continue;
		}
		const content = await readContent(text.textDocument.uri);
		documentChanges.push({
			...change as Record<string, unknown>,
			edits: normalizeTextEditsForContent(content, text.edits as LSPTextEdit[], positionEncoding),
		});
	}
	return { ...(edit.changes !== undefined ? { changes } : {}), ...(edit.documentChanges !== undefined ? { documentChanges } : {}) };
}

export function flattenWorkspaceTextEdits(edit: { changes?: Record<string, unknown[]>; documentChanges?: unknown[] }): Map<string, LSPTextEdit[]> {
	parseWorkspaceEdit(edit);
	const out = new Map<string, LSPTextEdit[]>();
	const push = (uri: string, edits: unknown[]) => {
		const textEdits = parseTextEdits(edits, uri);
		if (textEdits.length === 0) return;
		const existing = out.get(uri);
		if (existing) existing.push(...textEdits);
		else out.set(uri, [...textEdits]);
	};
	for (const [uri, edits] of Object.entries(edit.changes ?? {})) push(uri, edits);
	for (const change of edit.documentChanges ?? []) {
		const text = parseTextDocumentEdit(change, "documentChanges");
		if (text) push(text.textDocument.uri, text.edits);
	}
	return out;
}

function textEditKey(uri: string, edit: LSPTextEdit): string {
	return [uri, edit.range.start.line, edit.range.start.character, edit.range.end.line, edit.range.end.character, edit.newText].join(":");
}

export interface MergeWorkspaceEditsResult {
	edit: { changes: Record<string, LSPTextEdit[]> };
	droppedConflicts: number;
	inputEditCount: number;
	serverIds: string[];
}

export function mergeWorkspaceTextEditsByPriority(entries: Array<{ serverId: string; edit: { changes?: Record<string, unknown[]>; documentChanges?: unknown[] } | null | undefined }>): MergeWorkspaceEditsResult {
	const merged = new Map<string, LSPTextEdit[]>();
	const seenExact = new Set<string>();
	let droppedConflicts = 0;
	let inputEditCount = 0;
	const serverIds: string[] = [];
	for (const entry of entries) {
		serverIds.push(entry.serverId);
		if (!entry.edit) continue;
		for (const [uri, edits] of flattenWorkspaceTextEdits(entry.edit)) {
			const kept = merged.get(uri) ?? [];
			for (const edit of edits) {
				inputEditCount += 1;
				const exactKey = textEditKey(uri, edit);
				if (seenExact.has(exactKey)) continue;
				if (kept.some((existing) => rangesOverlap(existing.range, edit.range))) {
					droppedConflicts += 1;
					continue;
				}
				seenExact.add(exactKey);
				kept.push(edit);
			}
			if (kept.length > 0) merged.set(uri, kept);
		}
	}
	const changes: Record<string, LSPTextEdit[]> = {};
	for (const [uri, edits] of merged) changes[uri] = edits;
	return { edit: { changes }, droppedConflicts, inputEditCount, serverIds };
}

type WorkspaceEditOp =
	| { kind: "text"; uri: string; edits: LSPTextEdit[]; version?: number | null }
	| CreateFileOp
	| RenameFileOp
	| DeleteFileOp;

function pathIndexKey(uri: string): string {
	return normalizeMapKey(uriToPath(uri));
}

function parseResource(change: Record<string, unknown>): WorkspaceEditOp {
	const kind = change.kind;
	if (kind === "create") return { kind, uri: change.uri as string, options: parseResourceOptions(change.options, kind) };
	if (kind === "rename") return { kind, oldUri: change.oldUri as string, newUri: change.newUri as string, options: parseResourceOptions(change.options, kind) };
	if (kind === "delete") return { kind, uri: change.uri as string, options: parseResourceOptions(change.options, kind) };
	throw new Error(`unsupported workspace resource operation: ${String(kind)}`);
}

function planWorkspaceEdit(edit: { changes?: Record<string, unknown[]>; documentChanges?: unknown[] }): WorkspaceEditOp[] {
	parseWorkspaceEdit(edit);
	const ops: WorkspaceEditOp[] = [];
	const pending = new Map<string, { uri: string; edits: LSPTextEdit[]; version?: number | null }>();
	const descendants = new Map<string, Set<string>>();
	const indexedAncestors = new Map<string, string[]>();
	const seenResources = new Set<string>();
	const addIndex = (key: string): void => {
		const ancestors: string[] = [];
		let current = key;
		while (true) {
			const set = descendants.get(current) ?? new Set<string>();
			set.add(key);
			descendants.set(current, set);
			ancestors.push(current);
			const parent = path.dirname(current);
			if (parent === current) break;
			current = parent;
		}
		indexedAncestors.set(key, ancestors);
	};
	const removeIndex = (key: string): void => {
		for (const ancestor of indexedAncestors.get(key) ?? []) descendants.get(ancestor)?.delete(key);
		indexedAncestors.delete(key);
	};
	const queue = (uri: string, edits: LSPTextEdit[], version?: number | null): void => {
		const key = pathIndexKey(uri);
		const existing = pending.get(key);
		if (existing) {
			if (existing.version !== version && existing.version !== undefined && version !== undefined) {
				throw new Error(`conflicting text document versions for ${uri}`);
			}
			existing.edits.push(...edits);
			if (existing.version === undefined) existing.version = version;
			return;
		}
		pending.set(key, { uri, edits: [...edits], version });
		addIndex(key);
	};
	const flushUri = (uri: string): void => {
		const key = pathIndexKey(uri);
		const item = pending.get(key);
		if (!item) return;
		pending.delete(key);
		removeIndex(key);
		ops.push({ kind: "text", uri: item.uri, edits: item.edits, version: item.version });
	};
	const flushSubtree = (uri: string): void => {
		const key = pathIndexKey(uri);
		for (const candidate of [...(descendants.get(key) ?? [])]) {
			const item = pending.get(candidate);
			if (item) flushUri(item.uri);
		}
	};
	for (const [uri, edits] of Object.entries(edit.changes ?? {})) queue(uri, parseTextEdits(edits, `changes[${uri}]`));
	for (const [index, change] of (edit.documentChanges ?? []).entries()) {
		const text = parseTextDocumentEdit(change, `documentChanges[${index}]`);
		if (text) {
			queue(text.textDocument.uri, text.edits as LSPTextEdit[], text.textDocument.version);
			continue;
		}
		const resource = parseResource(change as Record<string, unknown>);
		const resourceKey = resource.kind === "rename"
			? `rename:${pathIndexKey(resource.oldUri)}:${pathIndexKey(resource.newUri)}`
			: `${resource.kind}:${pathIndexKey(resource.uri)}`;
		if (seenResources.has(resourceKey)) throw new Error(`duplicate workspace resource operation: ${resourceKey}`);
		seenResources.add(resourceKey);
		if (resource.kind === "create") flushUri(resource.uri);
		else if (resource.kind === "rename") {
			flushSubtree(resource.oldUri);
			flushSubtree(resource.newUri);
		} else flushSubtree(resource.uri);
		ops.push(resource);
	}
	for (const item of [...pending.values()]) flushUri(item.uri);
	return ops;
}

/** Test-only planning probe used by the scaled occupancy regression. */
export function __planWorkspaceEditForTest(edit: { changes?: Record<string, unknown[]>; documentChanges?: unknown[] }): number {
	return planWorkspaceEdit(edit).length;
}

function relativeToCwd(filePath: string, cwd: string): string {
	const rel = path.relative(cwd, filePath) || path.basename(filePath);
	return rel.replace(/\\/g, "/");
}

export function summarizeWorkspaceEdit(edit: { changes?: Record<string, unknown[]>; documentChanges?: unknown[] }, cwd: string): string[] {
	const lines: string[] = [];
	for (const [uri, edits] of flattenWorkspaceTextEdits(edit)) lines.push(`Apply ${edits.length} edit(s) to ${relativeToCwd(uriToPath(uri), cwd)}`);
	for (const change of edit.documentChanges ?? []) {
		if (!isRecord(change) || typeof change.kind !== "string") continue;
		if (change.kind === "create" && typeof change.uri === "string") lines.push(`Create ${relativeToCwd(uriToPath(change.uri), cwd)}`);
		else if (change.kind === "rename" && typeof change.oldUri === "string" && typeof change.newUri === "string") lines.push(`Rename ${relativeToCwd(uriToPath(change.oldUri), cwd)} → ${relativeToCwd(uriToPath(change.newUri), cwd)}`);
		else if (change.kind === "delete" && typeof change.uri === "string") lines.push(`Delete ${relativeToCwd(uriToPath(change.uri), cwd)}`);
	}
	return lines;
}

type VirtualFile = { exists: boolean; directory: boolean; content?: string };

async function lstatOrMissing(filePath: string): Promise<Stats | undefined> {
	try {
		return await fs.lstat(filePath);
	} catch (err) {
		if ((err as { code?: string }).code === "ENOENT") return undefined;
		throw err;
	}
}

async function assertParentIsUsable(filePath: string, virtual: Map<string, VirtualFile>): Promise<void> {
	let current = path.dirname(filePath);
	while (true) {
		const key = normalizeMapKey(current);
		const known = virtual.get(key);
		if (known) {
			if (!known.exists || !known.directory) throw new Error(`resource parent is not a directory: ${current}`);
			return;
		}
		const stat = await lstatOrMissing(current);
		if (stat) {
			if (!stat.isDirectory()) throw new Error(`resource parent is not a directory: ${current}`);
			return;
		}
		const parent = path.dirname(current);
		if (parent === current) throw new Error(`resource parent does not exist: ${filePath}`);
		current = parent;
	}
}

async function resolveExistingAncestor(filePath: string): Promise<string> {
	let current = path.resolve(filePath);
	const tail: string[] = [];
	while (true) {
		try {
			const resolved = await fs.realpath(current);
			return path.join(resolved, ...tail.reverse());
		} catch (err) {
			const code = (err as { code?: string }).code;
			if (code !== "ENOENT" && code !== "ENOTDIR") throw err;
			const parent = path.dirname(current);
			if (parent === current) throw err;
			tail.push(path.basename(current));
			current = parent;
		}
	}
}

async function preflightWorkspaceEdit(
	planned: WorkspaceEditOp[],
	cwd: string,
	options: ApplyWorkspaceEditOptions,
): Promise<{ text: Map<WorkspaceEditOp, LSPTextEdit[]>; ignored: Set<WorkspaceEditOp> }> {
	const root = await resolveExistingAncestor(cwd);
	const virtual = new Map<string, VirtualFile>();
	const text = new Map<WorkspaceEditOp, LSPTextEdit[]>();
	const ignored = new Set<WorkspaceEditOp>();
	const stateFor = async (filePath: string): Promise<VirtualFile> => {
		const key = normalizeMapKey(filePath);
		const known = virtual.get(key);
		if (known) return known;
		const stat = await lstatOrMissing(filePath);
		const value = { exists: Boolean(stat), directory: stat?.isDirectory() ?? false };
		virtual.set(key, value);
		return value;
	};
	const confine = async (uri: string): Promise<string> => {
		let filePath = "";
		try {
			const parsed = new URL(uri);
			if (parsed.protocol !== "file:" || (parsed.host !== "" && parsed.hostname !== "localhost")) throw new Error("URI must be a local file URI");
			filePath = uriToPath(uri);
		} catch (err) {
			throw new Error(`invalid workspace edit URI ${uri}: ${err instanceof Error ? err.message : String(err)}`);
		}
		if (!path.isAbsolute(filePath)) throw new Error(`workspace edit path escapes workspace: ${uri}`);
		const resolved = await resolveExistingAncestor(filePath);
		if (!isUnderDir(resolved, root)) throw new Error(`workspace edit path escapes workspace: ${uri}`);
		return filePath;
	};
	const contentFor = async (filePath: string, state: VirtualFile): Promise<string> => {
		if (!state.exists || state.directory) throw new Error(`text edit target is not a file: ${filePath}`);
		if (state.content !== undefined) return state.content;
		state.content = await fs.readFile(filePath, "utf-8");
		return state.content;
	};
	for (const op of planned) {
		if (op.kind === "text") {
			const filePath = await confine(op.uri);
			const state = await stateFor(filePath);
			if (op.version !== undefined && op.version !== null) {
				const current = options.documentVersions?.get(normalizeMapKey(filePath));
				if (current === undefined || current !== op.version) throw new Error(`stale text document version for ${filePath}: expected ${op.version}, current ${current ?? "unknown"}`);
			}
			const content = await contentFor(filePath, state);
			const normalized = normalizeTextEditsForContent(content, op.edits, options.positionEncoding ?? "utf-16");
			text.set(op, normalized);
			state.content = applyTextEditsToString(content, normalized);
			continue;
		}
		if (op.kind === "create") {
			const filePath = await confine(op.uri);
			const state = await stateFor(filePath);
			await assertParentIsUsable(filePath, virtual);
			if (state.exists) {
				if (op.options?.ignoreIfExists) { ignored.add(op); continue; }
				if (!op.options?.overwrite || state.directory) throw new Error(`create target already exists: ${filePath}`);
				state.content = "";
			} else {
				state.exists = true;
				state.directory = false;
				state.content = "";
			}
			continue;
		}
		if (op.kind === "rename") {
			const oldPath = await confine(op.oldUri);
			const newPath = await confine(op.newUri);
			if (pathsEqual(oldPath, newPath)) throw new Error("rename source and destination must differ");
			const source = await stateFor(oldPath);
			const destination = await stateFor(newPath);
			if (!source.exists) throw new Error(`rename source does not exist: ${oldPath}`);
			await assertParentIsUsable(newPath, virtual);
			if (destination.exists) {
				if (op.options?.ignoreIfExists) { ignored.add(op); continue; }
				if (!op.options?.overwrite) throw new Error(`rename destination already exists: ${newPath}`);
			}
			if (!source.directory) await contentFor(oldPath, source);
			virtual.set(normalizeMapKey(newPath), { ...source });
			virtual.set(normalizeMapKey(oldPath), { exists: false, directory: false });
			continue;
		}
		const filePath = await confine(op.uri);
		const state = await stateFor(filePath);
		if (!state.exists) {
			if (op.options?.ignoreIfNotExists) ignored.add(op);
			else throw new Error(`delete target does not exist: ${filePath}`);
		} else {
			if (state.directory && !op.options?.recursive) throw new Error(`delete directory requires recursive: ${filePath}`);
			state.exists = false;
			state.content = undefined;
		}
	}
	return { text, ignored };
}

/**
 * Applies a workspace edit. All URI, shape, version, resource-precondition and
 * text-bound checks happen in preflight before the first write. Once preflight
 * succeeds, an unexpected filesystem failure may still leave earlier mutations
 * applied; this is intentionally the existing no-rollback boundary.
 */
export async function applyWorkspaceEdit(
	edit: { changes?: Record<string, unknown[]>; documentChanges?: unknown[] },
	cwd: string,
	options: ApplyWorkspaceEditOptions = {},
): Promise<AppliedWorkspaceEdit> {
	const descriptions: string[] = [];
	const touchedFiles = new Set<string>();
	const fileDetails: AppliedWorkspaceFileDetail[] = [];
	const appliedOperationIndexes: number[] = [];
	let appliedOperationTotal = 0;
	let operationIndex = 0;
	const operationCounts = { textEdits: 0, create: 0, rename: 0, delete: 0 };
	const planned = planWorkspaceEdit(edit);
	for (const op of planned) {
		if (op.kind === "text") operationCounts.textEdits += op.edits.length;
		else operationCounts[op.kind]++;
	}
	const operationTotal =
		operationCounts.textEdits +
		operationCounts.create +
		operationCounts.rename +
		operationCounts.delete;
	const operationSize = (op: WorkspaceEditOp): number =>
		op.kind === "text" ? op.edits.length : 1;
	const markApplied = (op: WorkspaceEditOp): void => {
		const count = operationSize(op);
		for (let index = 0; index < count; index++) {
			if (appliedOperationIndexes.length < 100) {
				appliedOperationIndexes.push(operationIndex + index);
			}
		}
		appliedOperationTotal += count;
		operationIndex += count;
	};
	const skipOperation = (op: WorkspaceEditOp): void => {
		operationIndex += operationSize(op);
	};
	const makeResult = (): AppliedWorkspaceEdit => ({
		descriptions,
		files: [...touchedFiles],
		operationTotal,
		appliedOperationTotal,
		appliedOperationIndexes,
		operationCounts,
		fileDetails,
	});
	let prepared: Awaited<ReturnType<typeof preflightWorkspaceEdit>>;
	try {
		prepared = await preflightWorkspaceEdit(planned, cwd, options);
		for (const op of planned) {
			if (prepared.ignored.has(op)) {
				skipOperation(op);
				continue;
			}
			if (op.kind === "text") {
				const filePath = uriToPath(op.uri);
				const edits = prepared.text.get(op) ?? [];
				const content = await fs.readFile(filePath, "utf-8");
				const updated = applyTextEditsToString(content, edits, "utf-16");
				await fs.writeFile(filePath, updated, "utf-8");
				const start = Math.min(...edits.map((item) => item.range.start.line + 1));
				const end = Math.max(...edits.map((item) => item.range.end.line + 1));
				touchedFiles.add(filePath);
				fileDetails.push({ filePath, range: { start, end }, importsChanged: /^import\s/m.test(updated) });
				markApplied(op);
				descriptions.push(`Applied ${edits.length} edit(s) to ${relativeToCwd(filePath, cwd)}`);
			} else if (op.kind === "create") {
				const filePath = uriToPath(op.uri);
				await fs.mkdir(path.dirname(filePath), { recursive: true });
				if (op.options?.overwrite) await fs.writeFile(filePath, "", "utf-8");
				else await fs.writeFile(filePath, "", { flag: "wx" });
				touchedFiles.add(filePath);
				fileDetails.push({ filePath, range: { start: 1, end: 1 }, importsChanged: false });
				markApplied(op);
				descriptions.push(`Created ${relativeToCwd(filePath, cwd)}`);
			} else if (op.kind === "rename") {
				const oldPath = uriToPath(op.oldUri);
				const newPath = uriToPath(op.newUri);
				await fs.mkdir(path.dirname(newPath), { recursive: true });
				if (op.options?.overwrite) await fs.rm(newPath, { recursive: true, force: true });
				await fs.rename(oldPath, newPath);
				touchedFiles.add(oldPath);
				touchedFiles.add(newPath);
				fileDetails.push(
					{ filePath: oldPath, range: { start: 1, end: 1 }, importsChanged: true },
					{ filePath: newPath, range: { start: 1, end: 1 }, importsChanged: true },
				);
				markApplied(op);
				descriptions.push(`Renamed ${relativeToCwd(oldPath, cwd)} → ${relativeToCwd(newPath, cwd)}`);
			} else {
				const filePath = uriToPath(op.uri);
				await fs.rm(filePath, { recursive: op.options?.recursive === true, force: false });
				touchedFiles.add(filePath);
				fileDetails.push({ filePath, range: { start: 1, end: 1 }, importsChanged: true });
				markApplied(op);
				descriptions.push(`Deleted ${relativeToCwd(filePath, cwd)}`);
			}
		}
	} catch (err) {
		const partial = makeResult();
		if (options.mutationContext && options.observe !== false) {
			recordLspMutation(options.mutationContext, { results: [partial], status: "failed" });
		}
		const already = [...touchedFiles];
		if (already.length > 0) {
			const alreadyList = already.map((f) => `  • ${relativeToCwd(f, cwd)}`).join("\n");
			const failure = new Error(
				`Workspace edit failed mid-application — ${already.length} file(s) already written, no rollback performed:\n${alreadyList}\nCause: ${err instanceof Error ? err.message : String(err)}`,
			) as Error & { appliedWorkspaceEdit?: AppliedWorkspaceEdit };
			failure.appliedWorkspaceEdit = partial;
			throw failure;
		}
		throw err;
	}
	const applied = makeResult();
	if (options.mutationContext && options.observe !== false) {
		recordLspMutation(options.mutationContext, {
			results: [applied],
			status: appliedOperationTotal > 0 ? "success" : "skipped",
		});
	}
	return applied;
}

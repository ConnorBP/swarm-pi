/**
 * Searchable, paginated model picker for /swarm-config.
 *
 * Modeled on the tandem settings submenu: an Input for fuzzy search over a
 * scrolling window of models, plus a synthetic "inherit" row that clears an
 * override. Rendered inside a SettingsList submenu via ctx.ui.custom().
 */

import type { Theme } from "@earendil-works/pi-coding-agent";
import { Container, type Component, type Focusable, fuzzyFilter, Input, Key, matchesKey, Spacer, Text } from "@earendil-works/pi-tui";

export interface ModelItem {
	provider: string;
	id: string;
	name?: string;
	/** The value written to config: "provider/id", or "" for inherit. */
	value: string;
	inherit?: boolean;
}

function searchText(item: ModelItem): string {
	const name = item.name ? ` ${item.name}` : "";
	return `${item.id} ${item.provider} ${item.value}${name}`;
}

export interface ModelPickerOptions {
	title: string;
	currentValue: string;
	theme: Theme;
	/** Models with valid credentials (from ctx.modelRegistry). */
	registryModels: Array<{ provider?: string; id?: string; name?: string }>;
	/** Extra curated model ids ("provider/id") from settings.json enabledModels. */
	extraModelIds: string[];
	onSelect: (value: string) => void;
	onCancel: () => void;
}

const INHERIT_LABEL = "(inherit - use profile / default)";

export class ModelSelectSubmenu extends Container implements Component, Focusable {
	private input: Input;
	private listContainer: Container;
	private allModels: ModelItem[] = [];
	private filtered: ModelItem[] = [];
	private selectedIndex = 0;
	private readonly theme: Theme;
	private readonly onSelect: (value: string) => void;
	private readonly onCancel: () => void;
	private _focused = false;

	get focused(): boolean {
		return this._focused;
	}

	set focused(value: boolean) {
		this._focused = value;
		this.input.focused = value;
	}

	constructor(options: ModelPickerOptions) {
		super();
		this.theme = options.theme;
		this.onSelect = options.onSelect;
		this.onCancel = options.onCancel;

		this.addChild(new Text(options.theme.bold(options.theme.fg("accent", options.title)), 1, 0));
		this.addChild(new Spacer(1));
		this.input = new Input();
		this.focused = true;
		this.addChild(this.input);
		this.addChild(new Spacer(1));
		this.listContainer = new Container();
		this.addChild(this.listContainer);
		this.addChild(new Spacer(1));
		this.addChild(new Text(options.theme.fg("dim", "  Type to search - Enter to choose - Esc to cancel"), 1, 0));

		this.loadModels(options);
		this.updateList();
	}

	private loadModels(options: ModelPickerOptions): void {
		const byValue = new Map<string, ModelItem>();
		for (const m of options.registryModels) {
			if (typeof m.provider === "string" && typeof m.id === "string") {
				const value = `${m.provider}/${m.id}`;
				byValue.set(value, { provider: m.provider, id: m.id, name: m.name, value });
			}
		}
		for (const id of options.extraModelIds) {
			if (byValue.has(id)) continue;
			const slash = id.indexOf("/");
			const provider = slash > 0 ? id.slice(0, slash) : "";
			const modelId = slash > 0 ? id.slice(slash + 1) : id;
			byValue.set(id, { provider, id: modelId, value: id });
		}

		const models = Array.from(byValue.values()).sort((a, b) => {
			const byProvider = a.provider.localeCompare(b.provider);
			return byProvider !== 0 ? byProvider : a.id.localeCompare(b.id);
		});

		const inherit: ModelItem = { provider: "", id: INHERIT_LABEL, value: "", inherit: true };
		this.allModels = [inherit, ...models];
		this.filtered = this.allModels;

		const currentIndex = this.allModels.findIndex((m) => m.value === options.currentValue);
		this.selectedIndex = currentIndex >= 0 ? currentIndex : 0;
	}

	private filterModels(query: string): void {
		this.filtered = query ? fuzzyFilter(this.allModels, query, (item) => searchText(item)) : this.allModels;
		this.selectedIndex = Math.min(this.selectedIndex, Math.max(0, this.filtered.length - 1));
		this.updateList();
	}

	private updateList(): void {
		this.listContainer.clear();
		const maxVisible = 10;
		const start = Math.max(0, Math.min(this.selectedIndex - Math.floor(maxVisible / 2), this.filtered.length - maxVisible));
		const end = Math.min(start + maxVisible, this.filtered.length);

		for (let i = start; i < end; i++) {
			const item = this.filtered[i];
			if (!item) continue;
			const isSelected = i === this.selectedIndex;
			const label = item.inherit ? item.id : `${item.id} ${this.theme.fg("muted", `[${item.provider}]`)}`;
			if (isSelected) {
				this.listContainer.addChild(new Text(`${this.theme.fg("accent", "> ")}${this.theme.fg("accent", label)}`, 1, 0));
			} else {
				this.listContainer.addChild(new Text(`  ${label}`, 1, 0));
			}
		}

		if (start > 0 || end < this.filtered.length) {
			this.listContainer.addChild(new Text(this.theme.fg("muted", `  (${this.selectedIndex + 1}/${this.filtered.length})`), 1, 0));
		}
		if (this.filtered.length === 0) {
			this.listContainer.addChild(new Text(this.theme.fg("muted", "  No matching models"), 1, 0));
		}
	}

	handleInput(data: string): void {
		if (matchesKey(data, Key.up)) {
			if (this.filtered.length === 0) return;
			this.selectedIndex = this.selectedIndex === 0 ? this.filtered.length - 1 : this.selectedIndex - 1;
			this.updateList();
			return;
		}
		if (matchesKey(data, Key.down)) {
			if (this.filtered.length === 0) return;
			this.selectedIndex = this.selectedIndex === this.filtered.length - 1 ? 0 : this.selectedIndex + 1;
			this.updateList();
			return;
		}
		if (matchesKey(data, Key.enter)) {
			const selected = this.filtered[this.selectedIndex];
			if (selected) this.onSelect(selected.value);
			return;
		}
		if (matchesKey(data, Key.escape)) {
			this.onCancel();
			return;
		}
		this.input.handleInput(data);
		this.filterModels(this.input.getValue());
	}

	render(width: number): string[] {
		this.input.focused = this._focused;
		return super.render(width);
	}
}

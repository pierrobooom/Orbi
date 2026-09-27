// How a collection's things are named on screen, derived from what the user
// typed rather than asked for twice.

import { translate } from "@/i18n";
import type { CollectionResource } from "@/services/api";

/** "Quarto 1", "Quarto 2", "Quarto 3" → "quartos". Null when they differ.
 *
 * Units are almost always named "<kind> <number>", so the kind is in the
 * names already. Reading it back means "3 quartos" and "+ Adicionar quarto"
 * without a second field asking what a unit is called.
 */
export function unitKind(units: Pick<CollectionResource, "name">[]): { one: string; many: string } | null {
  if (units.length === 0) return null;
  const firsts = units.map((u) => u.name.trim().split(/\s+/)[0]?.toLowerCase() ?? "");
  const word = firsts[0];
  if (!word || firsts.some((w) => w !== word) || /^\d+$/.test(word)) return null;
  return { one: word, many: word.endsWith("s") ? word : `${word}s` };
}

/** "3 quartos", or "3 unidades" when the names do not share a kind. */
export function unitCount(units: Pick<CollectionResource, "name">[]): string {
  const kind = unitKind(units);
  const n = units.length;
  if (kind) return `${n} ${n === 1 ? kind.one : kind.many}`;
  return n === 1 ? translate("1 unit") : translate("{n} units", { n });
}

/** "Quarto 2" → "Q2" for the tight labels under the house card's bars. */
export function shortUnitName(name: string): string {
  const m = /^(\S+)\s+(\d+)$/.exec(name.trim());
  return m ? `${m[1][0].toUpperCase()}${m[2]}` : name;
}

export function firstName(person: string | null | undefined): string {
  return (person ?? "").trim().split(/\s+/)[0] ?? "";
}

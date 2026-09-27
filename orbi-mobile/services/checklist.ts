// Checklists inside a task's description, in the Markdown task-list form
// that Kanboard, GitHub and most notes apps already use:
//
//   Things to bring:
//   - [ ] Passport
//   - [x] Charger
//
// WHY IN THE DESCRIPTION AND NOT A TABLE
// The description is already the place a list lives — the AI puts an
// errand's items there, and people type them there. Keeping the checklist
// as plain text means it survives every path that touches the field
// unchanged: typed edits, voice edits, sharing, search embeddings, export.
// A separate items table would need all of those taught about it, and a
// description edited as text would drift out of step with it.
//
// Pure functions only, so the parsing can be tested without a screen.

// "- [ ] item", "* [x] item", "+ [X] item", or a bare "[ ] item". The
// bullet is optional because people type "[ ] milk" on a phone and mean
// the same thing.
const ITEM = /^(\s*)(?:[-*+]\s+)?\[( |x|X)\](?:\s+(.*))?$/;

export type ChecklistBlock =
  | { kind: "text"; text: string }
  | { kind: "item"; line: number; checked: boolean; text: string };

/** Split a description into runs of plain text and checklist items.
 *
 * `line` is the item's line number in the original text, which is what
 * toggleItem needs to flip exactly that box and nothing else.
 */
export function parseChecklist(description: string | null | undefined): ChecklistBlock[] {
  if (!description) return [];
  const blocks: ChecklistBlock[] = [];
  let pending: string[] = [];

  const flush = () => {
    const text = pending.join("\n").replace(/^\n+|\n+$/g, "");
    if (text) blocks.push({ kind: "text", text });
    pending = [];
  };

  description.split("\n").forEach((raw, line) => {
    const match = ITEM.exec(raw);
    if (match) {
      flush();
      blocks.push({
        kind: "item",
        line,
        checked: match[2] !== " ",
        text: (match[3] ?? "").trim(),
      });
    } else {
      pending.push(raw);
    }
  });
  flush();
  return blocks;
}

/** How many boxes there are and how many are ticked. */
export function checklistProgress(description: string | null | undefined): {
  done: number;
  total: number;
} {
  const items = parseChecklist(description).filter((b) => b.kind === "item");
  return {
    done: items.filter((b) => b.kind === "item" && b.checked).length,
    total: items.length,
  };
}

/** The description with one box flipped. Every other character is kept.
 *
 * Only the character inside the brackets changes, so the user's own
 * spacing, bullets and wording come back exactly as they wrote them. A
 * line that is not a checklist item is returned unchanged.
 */
export function toggleItem(description: string, line: number): string {
  const lines = description.split("\n");
  const raw = lines[line];
  if (raw === undefined || !ITEM.test(raw)) return description;
  lines[line] = raw.replace(/\[( |x|X)\]/, (box) => (box === "[ ]" ? "[x]" : "[ ]"));
  return lines.join("\n");
}

/** The description with an empty item appended, ready to be typed into. */
export function appendItem(description: string): string {
  const base = description.replace(/\s+$/, "");
  return base ? `${base}\n- [ ] ` : "- [ ] ";
}

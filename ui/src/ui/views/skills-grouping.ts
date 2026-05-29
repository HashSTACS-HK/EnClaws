import { t } from "../../i18n/index.ts";
import type { SkillStatusEntry } from "../types.ts";

export type SkillGroup = {
  id: string;
  label: string;
  skills: SkillStatusEntry[];
};

const SKILL_SOURCE_GROUPS: Array<{ id: string; label: string; sources: string[] }> = [
  { id: "workspace", label: "Workspace Skills", sources: ["enclaws-workspace"] },
  { id: "built-in", label: "Built-in Skills", sources: ["enclaws-bundled"] },
  { id: "installed", label: "Installed Skills", sources: ["enclaws-managed"] },
  { id: "extra", label: "Extra Skills", sources: ["enclaws-extra"] },
];

export function groupSkills(skills: SkillStatusEntry[]): SkillGroup[] {
  const groups = new Map<string, SkillGroup>();
  for (const def of SKILL_SOURCE_GROUPS) {
    groups.set(def.id, { id: def.id, label: def.label, skills: [] });
  }
  const builtInGroup = SKILL_SOURCE_GROUPS.find((group) => group.id === "built-in");
  const other: SkillGroup = { id: "other", label: "Other Skills", skills: [] };
  for (const skill of skills) {
    const match = skill.bundled
      ? builtInGroup
      : SKILL_SOURCE_GROUPS.find((group) => group.sources.includes(skill.source));
    if (match) {
      groups.get(match.id)?.skills.push(skill);
    } else {
      other.skills.push(skill);
    }
  }
  const ordered = SKILL_SOURCE_GROUPS.map((group) => groups.get(group.id)).filter(
    (group): group is SkillGroup => Boolean(group && group.skills.length > 0),
  );
  if (other.skills.length > 0) {
    ordered.push(other);
  }
  return ordered;
}

// ---------------------------------------------------------------------------
// Bundled skill sub-categories (mirrors tool group IDs on the tools page)
// ---------------------------------------------------------------------------

export type BundledSkillCategoryDef = {
  id: string;
  labelKey: string;
  match: (skillKey: string) => boolean;
};

export const BUNDLED_SKILL_CATEGORY_DEFS: BundledSkillCategoryDef[] = [
  { id: "feishu", labelKey: "tenantSkills.skillCatFeishu", match: (k) => k.startsWith("feishu-") },
  { id: "memory", labelKey: "tenantSkills.skillCatMemory", match: (k) => k === "memory-manager" },
  { id: "sessions", labelKey: "tenantSkills.skillCatSessions", match: (k) => k === "session-logs" },
  {
    id: "runtime",
    labelKey: "tenantSkills.skillCatRuntime",
    match: (k) => ["coding-agent", "healthcheck", "pingtest"].includes(k),
  },
  {
    id: "automation",
    labelKey: "tenantSkills.skillCatAutomation",
    match: (k) => ["skill-creator", "mcporter"].includes(k),
  },
  { id: "web", labelKey: "tenantSkills.skillCatWeb", match: (k) => k === "weather" },
];

export function groupBundledSkillsByCategory(skills: SkillStatusEntry[]): SkillGroup[] {
  const groups = new Map<string, SkillGroup>();
  for (const def of BUNDLED_SKILL_CATEGORY_DEFS) {
    groups.set(def.id, { id: def.id, label: t(def.labelKey), skills: [] });
  }
  const other: SkillGroup = { id: "other", label: t("tenantSkills.skillCatOther"), skills: [] };
  for (const skill of skills) {
    const cat = BUNDLED_SKILL_CATEGORY_DEFS.find((c) => c.match(skill.skillKey));
    if (cat) {
      groups.get(cat.id)!.skills.push(skill);
    } else {
      other.skills.push(skill);
    }
  }
  const ordered = BUNDLED_SKILL_CATEGORY_DEFS.map((cat) => groups.get(cat.id)!).filter(
    (g) => g.skills.length > 0,
  );
  if (other.skills.length > 0) {
    ordered.push(other);
  }
  return ordered;
}

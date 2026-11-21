import type {
  AgentCapabilityLevel,
  AgentCapabilityQuery,
  UserSkillRecord,
} from "@pi-desktop/shared";

/**
 * Explicit Skills management scope (D257 follow-up). It replaces the old
 * All/Global/Project source filter: Global management is workspace-independent
 * and Project management resolves everything against one selected project.
 */
export type SkillsManagementMode = "global" | "project";

/**
 * A user skill row as the settings page consumes it. The backend populates
 * `enabledSource`/`globalEnabled` only on global rows listed with a project
 * context; project rows and context-free global rows omit both fields.
 */
export type ManagedUserSkill = UserSkillRecord & {
  enabledSource?: "inherited" | "override";
  globalEnabled?: boolean;
};

export const SKILLS_GLOBAL_PATH = "~/.agents/skills";

export function projectSkillsPath(projectPath: string | null): string {
  return projectPath ? `${projectPath}/.agents/skills` : "<project-root>/.agents/skills";
}

/**
 * True only when the host reports a stored per-project override. Override
 * state is never inferred from boolean equality: a stored override can equal
 * the global default (and the toggle write path prunes only at write time),
 * so only the field decides.
 */
export function isSkillOverrideForProject(skill: ManagedUserSkill): boolean {
  return skill.enabledSource === "override";
}

/**
 * The query for the global column. Global management is workspace-independent
 * and never sends a projectPath; Project management always pairs the global
 * level with the selected project so rows carry override provenance.
 */
export function globalSkillsQuery(
  mode: SkillsManagementMode,
  projectPath: string | null,
): AgentCapabilityQuery {
  if (mode === "project" && projectPath) return { level: "global", projectPath };
  return { level: "global" };
}

/** The query for the project column, or null when no project is selected. */
export function projectSkillsQuery(projectPath: string | null): AgentCapabilityQuery | null {
  return projectPath ? { level: "project", projectPath } : null;
}

export type SkillsScope = {
  mode: SkillsManagementMode;
  projectPath: string | null;
};

export function sameSkillsScope(a: SkillsScope, b: SkillsScope): boolean {
  return a.mode === b.mode && (a.projectPath ?? null) === (b.projectPath ?? null);
}

 /**
  * Where a new or imported skill lands. Project management without a selected
  * project cannot name a destination, so callers must report it instead of
  * failing silently or falling back to a hidden workspace project.
  */
 export type SkillWriteDestination =
   | { ok: true; level: "global"; projectPath?: undefined }
   | { ok: true; level: "project"; projectPath: string }
   | { ok: false; error: "select-project-first" };

 export function skillWriteDestination(
   mode: SkillsManagementMode,
   projectPath: string | null,
 ): SkillWriteDestination {
   if (mode === "global") return { ok: true, level: "global" };
   if (projectPath) return { ok: true, level: "project", projectPath };
   return { ok: false, error: "select-project-first" };
 }

 /**
  * Toggle context for one row. A project-management global row toggles only
  * the project's override of that global skill; every other row toggles its
  * own level record without a project context.
  */
 export function toggleQueryForRow(
   scope: SkillsScope,
   rowLevel: AgentCapabilityLevel,
 ): AgentCapabilityQuery {
   if (scope.mode === "project" && rowLevel === "global" && scope.projectPath) {
     return { level: "global", projectPath: scope.projectPath };
   }
   if (rowLevel === "project" && scope.projectPath) {
     return { level: "project", projectPath: scope.projectPath };
   }
   return { level: rowLevel };
 }
 
/**
 * The provenance a project-context global row carries right after its switch
 * flips. The host toggle prunes the stored override exactly when the new value
 * equals the global default (see host-core `CapabilityState::set_enabled`),
 * and any other write path leaves the stored presence for the next load to
 * report — so this prediction is exact for the toggle call itself.
 */
export function provenanceAfterToggle(
  skill: ManagedUserSkill,
  next: boolean,
): Pick<ManagedUserSkill, "enabled" | "enabledSource"> {
  if (skill.enabledSource === undefined) return { enabled: next };
  const globalDefault = skill.globalEnabled ?? true;
  return { enabled: next, enabledSource: next === globalDefault ? "inherited" : "override" };
}

/**
 * Stamps every load so a slow fetch for a previous scope can never overwrite
 * the current one, and stamps every mutation so a response that lands after a
 * scope switch reloads instead of patching rows it no longer owns.
 */
export function createSkillsScopeGuard() {
  let token = 0;
  let current: SkillsScope = { mode: "global", projectPath: null };
  return {
    update(scope: SkillsScope): number {
      current = { mode: scope.mode, projectPath: scope.projectPath ?? null };
      token += 1;
      return token;
    },
    capture(): { scope: SkillsScope; token: number } {
      return { scope: current, token };
    },
    isCurrent(captured: { token: number }): boolean {
      return captured.token === token;
    },
    current(): SkillsScope {
      return current;
    },
  };
}

export type SkillsScopeGuard = ReturnType<typeof createSkillsScopeGuard>;

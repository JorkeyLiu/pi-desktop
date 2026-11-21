import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  GLOBAL_SCOPE,
  type AgentCapabilityLevel,
  type BuiltinSkillRecord,
} from "@pi-desktop/shared";
import { api } from "../../lib/api";
import { useAppStore } from "../../stores/app-store";
import { useHostCollection } from "../../hooks/use-host-collection";
 import { useAgentProjects } from "./AgentCapabilityLayout";
 
 /**
  * Delete-arm state this workflow mutates. Owned by the page through the
  * shared `useArmedDelete` hook, so the arm keeps its single expiring
  * implementation instead of a second copy with its own timeout.
  */
 export type SkillsDeleteArm = {
   armed: string | null;
   setArmed: (id: string | null) => void;
 };
import {
  draftFromSkill,
  emptySkillDraft,
  type SkillDraft,
} from "./SkillEditorSheet";
import {
  createSkillsScopeGuard,
  globalSkillsQuery,
  isSkillOverrideForProject,
  projectSkillsQuery,
  provenanceAfterToggle,
  sameSkillsScope,
  skillWriteDestination,
  toggleQueryForRow,
  type ManagedUserSkill,
  type SkillsManagementMode,
  type SkillsScope,
} from "./skills-management-model";

export type { ManagedUserSkill, SkillsManagementMode };

export type SkillEditorState = {
  draft: SkillDraft;
  editing: ManagedUserSkill | null;
  level: AgentCapabilityLevel;
};

type SkillCollection = {
  builtins: BuiltinSkillRecord[];
  global: ManagedUserSkill[];
  project: ManagedUserSkill[];
};

const EMPTY_SKILL_COLLECTION: SkillCollection = { builtins: [], global: [], project: [] };

const rowKey = (level: AgentCapabilityLevel, id: string) => `${level}:${id}`;
const builtinRowKey = (id: string) => `builtin:${id}`;

/**
 * Data and workflow for the Skills page, extracted so the page stays a
 * renderer. One scope — management mode plus selected project — owns every
 * request: loads retire stale scopes via `useHostCollection`'s request stamp,
 * and mutations capture their scope and reload instead of patching rows they
 * no longer own when the scope moved under them.
 */
 export function useAgentSkillsManagement(arm: SkillsDeleteArm) {
  const { t } = useTranslation();
  const showToast = useAppStore((state) => state.showToast);
  const { selectedProjectPath, setSelectedProjectPath, options } = useAgentProjects();
  const [mode, setModeState] = useState<SkillsManagementMode>("global");
  const guard = useRef(createSkillsScopeGuard());
  const scope: SkillsScope = useMemo(
    () => ({ mode, projectPath: selectedProjectPath }),
    [mode, selectedProjectPath],
  );
  useEffect(() => {
    guard.current.update(scope);
  }, [scope]);

   // The fetch closes over the current scope, so its identity changes with
   // every mode or project switch and `useHostCollection` reloads (retiring
   // the in-flight request for the dead scope) instead of showing stale rows.
   const fetchSkills = useCallback(async (): Promise<SkillCollection> => {
     const [builtins, global, project] = await Promise.all([
       api.listBuiltinSkills(),
       api.listUserSkills(globalSkillsQuery(scope.mode, scope.projectPath)),
       (() => {
         const query = projectSkillsQuery(
           scope.mode === "project" ? scope.projectPath : null,
         );
         return query
           ? api.listUserSkills(query)
           : Promise.resolve({ skills: [] as ManagedUserSkill[] });
       })(),
     ]);
     return {
       builtins: builtins.builtins ?? [],
       global: (global.skills ?? []) as ManagedUserSkill[],
       project: (project.skills ?? []) as ManagedUserSkill[],
     };
   }, [scope]);

  const {
    data: { builtins: builtinSkills, global: globalSkills, project: projectSkills },
    setData: setSkills,
    loading,
    refreshing,
    reload: load,
  } = useHostCollection(fetchSkills, EMPTY_SKILL_COLLECTION, (error) =>
    showToast(error instanceof Error ? error.message : String(error), { variant: "error" }),
  );

  const [search, setSearch] = useState("");
  const [busyId, setBusyId] = useState<string | null>(null);
  const [editor, setEditor] = useState<SkillEditorState | null>(null);
  const [view, setView] = useState<"skills" | "market">("skills");
  const [saving, setSaving] = useState(false);
  const [moveDestinationFor, setMoveDestinationFor] = useState<ManagedUserSkill | null>(null);
   const { armed, setArmed } = arm;

  const setMode = useCallback((next: SkillsManagementMode) => {
    setModeState(next);
    setArmed(null);
    setMoveDestinationFor(null);
  }, [setArmed]);

  /** Switch management scope and open the market there. */
  const goGlobal = useCallback(() => setMode("global"), [setMode]);

  const patchBuiltin = (id: string, patch: Partial<BuiltinSkillRecord>) => {
    setSkills((current) => ({
      ...current,
      builtins: current.builtins.map((row) => (row.id === id ? { ...row, ...patch } : row)),
    }));
  };

  const patchRow = (
    level: AgentCapabilityLevel,
    id: string,
    patch: Partial<ManagedUserSkill>,
  ) => {
    setSkills((current) => ({
      ...current,
      [level]: current[level].map((row) => (row.id === id ? { ...row, ...patch } : row)),
    }));
  };

  const destination = skillWriteDestination(mode, selectedProjectPath);

  /**
   * The switch flips locally first and only reverts if the host refuses, so one
   * row's request never blanks the list or freezes the others. A response that
   * lands after a scope switch only reloads — it never patches the new scope.
   */
  const toggle = async (skill: ManagedUserSkill, level: AgentCapabilityLevel) => {
    const key = rowKey(level, skill.id);
    if (busyId === key) return;
    const captured = guard.current.capture();
    const query = toggleQueryForRow(captured.scope, level);
    const next = !skill.enabled;
    setBusyId(key);
    patchRow(level, skill.id, provenanceAfterToggle(skill, next));
    try {
      await api.setUserSkillEnabled(skill.id, next, query);
      if (!guard.current.isCurrent(captured) || !sameSkillsScope(captured.scope, guard.current.current())) {
        await load();
        return;
      }
      showToast(
        t(next ? "settings.capabilityEnabled" : "settings.capabilityDisabled", {
          name: skill.name || skill.id,
        }),
        { variant: "success" },
      );
    } catch (error) {
      if (guard.current.isCurrent(captured)) {
        patchRow(level, skill.id, { enabled: skill.enabled, enabledSource: skill.enabledSource });
      } else {
        await load();
      }
      showToast(error instanceof Error ? error.message : String(error), { variant: "error" });
    } finally {
      setBusyId(null);
    }
  };

  const toggleBuiltin = async (skill: BuiltinSkillRecord) => {
    const key = builtinRowKey(skill.id);
    if (busyId === key) return;
    const next = !skill.enabled;
    setBusyId(key);
    patchBuiltin(skill.id, { enabled: next });
    try {
      await api.setBuiltinSkillEnabled(skill.id, next);
      showToast(
        t(next ? "settings.capabilityEnabled" : "settings.capabilityDisabled", {
          name: skill.name || skill.id,
        }),
        { variant: "success" },
      );
    } catch (error) {
      patchBuiltin(skill.id, { enabled: skill.enabled });
      showToast(error instanceof Error ? error.message : String(error), { variant: "error" });
    } finally {
      setBusyId(null);
    }
  };

  /**
   * Restore a project-context global row to the global default. The mutation
   * result is ignored — the reload is the truth — and only the selected
   * project's override is cleared. Only offered on overridden rows.
   */
  const resetInheritance = async (skill: ManagedUserSkill) => {
    const projectPath = scope.projectPath;
    if (!projectPath || !isSkillOverrideForProject(skill)) return;
    const key = rowKey("global", skill.id);
    if (busyId === key) return;
    const captured = guard.current.capture();
    setBusyId(key);
    try {
      await api.resetUserSkillEnabled(skill.id, { level: "global", projectPath });
      await load();
      if (!guard.current.isCurrent(captured)) return;
      showToast(t("settings.skillInheritanceRestored", { name: skill.name || skill.id }), {
        variant: "success",
      });
    } catch (error) {
      showToast(error instanceof Error ? error.message : String(error), { variant: "error" });
    } finally {
      setBusyId(null);
    }
  };

   const openCreate = () => {
     if (!destination.ok) {
       showToast(t("settings.selectProjectFirst"), { variant: "error" });
       return;
     }
     const target = destination;
     setEditor({
       draft: {
         ...emptySkillDraft(),
         scope:
           target.level === "global"
             ? GLOBAL_SCOPE
             : { mode: "projects", projects: [target.projectPath] },
       },
       editing: null,
       level: target.level,
     });
   };

  const openEdit = async (skill: ManagedUserSkill, level: AgentCapabilityLevel) => {
    const key = rowKey(level, skill.id);
    const captured = guard.current.capture();
    setBusyId(key);
    try {
      const query = toggleQueryForRow(captured.scope, level);
      const result = await api.readUserSkill(skill.id, query);
      if (!guard.current.isCurrent(captured)) return;
      setEditor({
        draft: draftFromSkill((result.skill ?? skill) as ManagedUserSkill, result.body ?? ""),
        editing: ((result.skill ?? skill) as ManagedUserSkill),
        level,
      });
    } catch (error) {
      showToast(error instanceof Error ? error.message : String(error), { variant: "error" });
    } finally {
      setBusyId(null);
    }
  };

  const saveEditor = async () => {
    if (!editor) return;
    const { draft, editing, level } = editor;
    const captured = guard.current.capture();
    const projectPath =
      level === "project" ? captured.scope.projectPath ?? undefined : undefined;
    if (level === "project" && !projectPath) {
      showToast(t("settings.selectProjectFirst"), { variant: "error" });
      return;
    }
    const payload = {
      name: draft.name.trim(),
      description: draft.description.trim(),
      body: draft.body,
      enabled: draft.enabled,
      scope: draft.scope,
      level,
      ...(projectPath ? { projectPath } : {}),
    };
    setSaving(true);
    try {
      if (editing) await api.updateUserSkill(editing.id, payload);
      else await api.createUserSkill(payload);
      await load();
      if (!guard.current.isCurrent(captured)) return;
      showToast(
        t(editing ? "settings.skillSaved" : "settings.skillCreated", { name: payload.name }),
        { variant: "success" },
      );
      setEditor(null);
    } catch (error) {
      showToast(error instanceof Error ? error.message : String(error), { variant: "error" });
    } finally {
      setSaving(false);
    }
  };

  const reveal = async (skill: ManagedUserSkill, level: AgentCapabilityLevel) => {
    try {
      await api.revealUserSkill(skill.id, toggleQueryForRow(scope, level));
    } catch (error) {
      showToast(error instanceof Error ? error.message : String(error), { variant: "error" });
    }
  };

  const remove = async (skill: ManagedUserSkill, level: AgentCapabilityLevel) => {
    const key = rowKey(level, skill.id);
    setBusyId(key);
    try {
      await api.removeUserSkill(skill.id, toggleQueryForRow(scope, level));
      await load();
      showToast(t("settings.capabilityDeleted", { name: skill.name || skill.id }), {
        variant: "success",
      });
    } catch (error) {
      showToast(error instanceof Error ? error.message : String(error), { variant: "error" });
    } finally {
      setBusyId(null);
      setArmed(null);
    }
  };

   const importSkill = async (
     level: AgentCapabilityLevel = destination.ok ? destination.level : "global",
     sourceKind: "file" | "dir" = "file",
   ) => {
    const projectPath = level === "project" ? selectedProjectPath : null;
    if (level === "project" && !projectPath) {
      showToast(t("settings.selectProjectFirst"), { variant: "error" });
      return;
    }
    setBusyId(sourceKind === "dir" ? "import-dir" : "import");
    try {
      const result = await api.importUserSkill({
        level,
        sourceKind,
        ...(level === "project" && projectPath ? { projectPath } : {}),
      });
      if (!result.canceled) {
        await load();
        if (result.skill) {
          showToast(t("settings.skillImported", { name: result.skill.name }), {
            variant: "success",
          });
        }
        if (result.imported?.length) {
          showToast(t("settings.skillBatchImported", { count: result.imported.length }), {
            variant: "success",
          });
        }
        if (result.failed?.length) {
          const first = result.failed[0];
          const folder = first.path.split(/[\\/]/).filter(Boolean).at(-1) ?? first.path;
          showToast(t("settings.skillBatchFailed", {
            count: result.failed.length,
            first: `${folder}: ${first.error}`,
          }), { variant: "error" });
        }
      }
    } catch (error) {
      showToast(error instanceof Error ? error.message : String(error), { variant: "error" });
    } finally {
      setBusyId(null);
    }
  };

  /**
   * Move a project skill to Global. The document moves rather than copies, and
   * a destination that already holds the id or display name renames the
   * arriving skill, so the toast reports the new name instead of pretending
   * the id survived.
   */
  const moveToGlobal = async (skill: ManagedUserSkill) => {
    const projectPath = scope.projectPath;
    if (!projectPath) {
      showToast(t("settings.selectProjectFirst"), { variant: "error" });
      return;
    }
    const key = rowKey("project", skill.id);
    setBusyId(key);
    try {
      const result = await api.transferUserSkill({
        id: skill.id,
        from: { level: "project", projectPath },
        to: { level: "global" },
      });
      await load();
      const name = skill.name || skill.id;
      const arrived = result.skill;
      showToast(
        arrived && arrived.id !== skill.id
          ? t("settings.capabilityMovedRenamed", {
              name,
              target: t("settings.globalLevel"),
              newName: arrived.name || arrived.id,
            })
          : t("settings.capabilityMoved", { name, target: t("settings.globalLevel") }),
        { variant: "success" },
      );
    } catch (error) {
      showToast(error instanceof Error ? error.message : String(error), { variant: "error" });
    } finally {
      setBusyId(null);
    }
  };

  /**
   * Move a global skill into an explicitly chosen project. Global management
   * shows no project picker, so the destination is picked in the move dialog
   * itself — never a hidden workspace project.
   */
  const confirmMoveToProject = async (destinationProjectPath: string) => {
    const skill = moveDestinationFor;
    if (!skill || !destinationProjectPath) return;
    const key = rowKey("global", skill.id);
    setBusyId(key);
    try {
      const result = await api.transferUserSkill({
        id: skill.id,
        from: { level: "global" },
        to: { level: "project", projectPath: destinationProjectPath },
      });
      await load();
      const name = skill.name || skill.id;
      const arrived = result.skill;
      const target = options.find((project) => project.path === destinationProjectPath)?.name
        ?? destinationProjectPath;
      showToast(
        arrived && arrived.id !== skill.id
          ? t("settings.capabilityMovedRenamed", {
              name,
              target,
              newName: arrived.name || arrived.id,
            })
          : t("settings.capabilityMoved", { name, target }),
        { variant: "success" },
      );
      setMoveDestinationFor(null);
    } catch (error) {
      showToast(error instanceof Error ? error.message : String(error), { variant: "error" });
    } finally {
      setBusyId(null);
    }
  };

  return {
    mode,
    setMode,
    goGlobal,
    scope,
    selectedProjectPath,
    setSelectedProjectPath,
    options,
    builtinSkills,
    globalSkills,
    projectSkills,
    loading,
    refreshing,
    reload: load,
    search,
    setSearch,
    busyId,
    armed,
    setArmed,
    editor,
    setEditor,
    saving,
    view,
    setView,
    moveDestinationFor,
    setMoveDestinationFor,
    destination,
    toggle,
    toggleBuiltin,
    resetInheritance,
    openCreate,
    openEdit,
    saveEditor,
    closeEditor: () => {
      if (!saving) setEditor(null);
    },
    reveal,
    remove,
    importSkill,
    moveToGlobal,
    confirmMoveToProject,
  };
}

export type AgentSkillsManagement = ReturnType<typeof useAgentSkillsManagement>;

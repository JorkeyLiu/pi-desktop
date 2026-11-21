import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import type { BuiltinSkillRecord } from "@pi-desktop/shared";
import {
  AgentCapabilityPage,
  AgentProjectPicker,
  CapabilityButton,
  CapabilityEmpty,
  CapabilityGroupHeader,
  CapabilityPanel,
  CapabilityRow,
  CapabilityRowMenu,
  CapabilityToggle,
  CapabilityToolbar,
   matchesCapabilitySearch,
   projectDisplayName,
   type CapabilityMenuItem,
   useArmedDelete,
 } from "./AgentCapabilityLayout";
import {
  SkillEditorSheet,
} from "./SkillEditorSheet";
import {
  IconArrowUpDown,
  IconBookOpen,
  IconDownload,
  IconFileText,
  IconFolderOpen,
  IconPencil,
  IconPlus,
  IconTrash,
} from "../icons";
import { SkillMarketPanel } from "./SkillMarketPanel";
import { AgentSkillImportPanel } from "../../features/settings/imports/AgentSkillImportPanel";
import { ImportToggleButton } from "../../features/settings/import-workbench";
import { SettingsMenuSelect } from "./SettingsMenuSelect";
import { SegmentedControl, TooltipButton } from "../ui";
import {
  SKILLS_GLOBAL_PATH,
  isSkillOverrideForProject,
  projectSkillsPath,
  type ManagedUserSkill,
  type SkillsManagementMode,
} from "./skills-management-model";
import { useAgentSkillsManagement } from "./useAgentSkillsManagement";

/**
 * Skills settings page: explicit Global management vs Project management.
 * Global management is workspace-independent — it queries global skills
 * without a projectPath and owns builtins plus global documents. Project
 * management resolves one project: its own skills plus that project's view
 * of the global skills, where the switch writes a per-project override and
 * content edits go through Global management.
  */
 export function AgentSkillsPage() {
   const { t } = useTranslation();
   // The page owns the delete arm through the shared hook: one expiring
   // implementation, and mode switches disarm through the workflow below.
   const deleteArm = useArmedDelete();
   const management = useAgentSkillsManagement(deleteArm);
  const {
    mode,
    setMode,
    goGlobal,
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
    closeEditor,
    reveal,
    remove,
    importSkill,
    moveToGlobal,
    confirmMoveToProject,
  } = management;
  const [menuFor, setMenuFor] = useState<string | null>(null);
  const [importOpen, setImportOpen] = useState(false);
  const [moveProjectChoice, setMoveProjectChoice] = useState<string>("");

  const isProjectMode = mode === "project";
  const rowKey = (level: "global" | "project", id: string) => `${level}:${id}`;
  const builtinRowKey = (id: string) => `builtin:${id}`;

  const visible = useMemo(() => {
    const match = (skill: ManagedUserSkill) =>
      matchesCapabilitySearch(search, skill.name, skill.id, skill.description);
    const matchBuiltin = (skill: BuiltinSkillRecord) =>
      matchesCapabilitySearch(search, skill.name, skill.id, skill.description);
    return {
      builtins: builtinSkills.filter(matchBuiltin),
      global: globalSkills.filter(match),
      project: projectSkills.filter(match),
    };
  }, [builtinSkills, globalSkills, projectSkills, search]);

  const counts = useMemo(
    () => ({
      global: visible.builtins.length + visible.global.length,
      project: visible.project.length + visible.global.length,
    }),
    [visible],
  );

  const projectName = useMemo(
    () =>
      options.find((project) => project.path === selectedProjectPath)?.name ??
      (selectedProjectPath ? projectDisplayName(selectedProjectPath) : undefined),
    [options, selectedProjectPath],
  );

  const modeSegments = useMemo(
    () =>
      [
        {
          value: "global" as SkillsManagementMode,
          label: (
            <>
              {t("settings.skillsManageGlobal")}
              <span className="agent-capability-segment-count">{counts.global}</span>
            </>
          ),
        },
        {
          value: "project" as SkillsManagementMode,
          label: (
            <>
              {t("settings.skillsManageProject")}
              <span className="agent-capability-segment-count">{counts.project}</span>
            </>
          ),
        },
      ],
    [counts, t],
  );

   const newSkillTitle = !destination.ok
     ? t("settings.selectProjectFirst")
     : destination.level === "project"
       ? t("settings.capabilityCreateInProject")
       : t("settings.capabilityCreateInGlobal");

  const importButton = (level: "global" | "project", enabled: boolean) =>
    enabled ? (
      <>
        <CapabilityButton
          busy={busyId === "import"}
          title={
            level === "project"
              ? t("settings.capabilityImportToProject")
              : t("settings.capabilityImportToGlobal")
          }
          onClick={() => void importSkill(level, "file")}
        >
          <IconDownload size={14} />
          {t("settings.importSkillFile")}
        </CapabilityButton>
        <CapabilityButton
          busy={busyId === "import-dir"}
          title={
            level === "project"
              ? t("settings.capabilityImportToProject")
              : t("settings.capabilityImportToGlobal")
          }
          onClick={() => void importSkill(level, "dir")}
        >
          <IconDownload size={14} />
          {t("settings.importSkillDir")}
        </CapabilityButton>
      </>
    ) : undefined;

  const marketButton = (
    <CapabilityButton onClick={() => setView("market")}>
      <IconFileText size={14} />
      {t("settings.sklm.browse")}
    </CapabilityButton>
  );

  if (view === "market") {
    return (
      <SkillMarketPanel
        installedIds={[...globalSkills, ...projectSkills].map((skill) => skill.id)}
        level={isProjectMode && selectedProjectPath ? "project" : "global"}
        projectPath={isProjectMode ? (selectedProjectPath ?? undefined) : undefined}
        projectName={projectName}
        onGoGlobal={goGlobal}
        onBack={() => {
          setView("skills");
          void load();
        }}
        onInstalled={() => {
          setView("skills");
          void load();
        }}
      />
    );
  }

  const renderBuiltinRow = (skill: BuiltinSkillRecord, editable: boolean) => {
    const key = builtinRowKey(skill.id);
    const name = skill.name || skill.id;
    const busy = busyId === key;
    return (
      <CapabilityRow
        key={key}
        glyph={<IconBookOpen size={16} />}
        name={name}
        off={!skill.enabled}
        badges={
          <span className="agent-capability-badge is-level">{t("settings.builtin")}</span>
        }
        description={skill.description || t("settings.noCapabilityDescription")}
        meta={
          editable ? undefined : (
            <span className="agent-capability-hint">{t("settings.skillsBuiltinsGlobalOnlyHint")}</span>
          )
        }
        actions={
          editable ? (
            <CapabilityToggle
              checked={skill.enabled}
              busy={busy}
              label={t("settings.toggleCapability", { name })}
              onChange={() => void toggleBuiltin(skill)}
            />
          ) : (
            <CapabilityButton onClick={goGlobal}>
              {t("settings.skillOpenInGlobal")}
            </CapabilityButton>
          )
        }
      />
    );
  };

  const renderGlobalRow = (skill: ManagedUserSkill) => {
    // Global management owns the documents: full controls.
    const key = rowKey("global", skill.id);
    const name = skill.name || skill.id;
    const busy = busyId === key;
    const isArmed = armed === key;
    const items: CapabilityMenuItem[] = [
      {
        key: "reveal",
        label: t("extensions.skills.reveal"),
        icon: <IconFolderOpen size={14} />,
        onSelect: () => {
          setMenuFor(null);
          void reveal(skill, "global");
        },
      },
       {
         key: "move",
         label: t("settings.capabilityMoveToProjectMenu"),
         icon: <IconArrowUpDown size={14} />,
         disabled: options.length === 0,
         onSelect: () => {
           setMenuFor(null);
           setMoveProjectChoice("");
           setMoveDestinationFor(skill);
         },
       },
      {
        key: "remove",
        label: isArmed ? t("settings.capabilityRemoveConfirm") : t("extensions.skills.remove"),
        icon: <IconTrash size={14} />,
        danger: true,
        onSelect: () => {
          if (isArmed) {
            setMenuFor(null);
            void remove(skill, "global");
          } else {
            setArmed(key);
          }
        },
      },
    ];
    return (
      <CapabilityRow
        key={key}
        glyph={<IconBookOpen size={16} />}
        name={name}
        off={!skill.enabled}
        menuOpen={menuFor === key}
        badges={
          <>
            <span className="agent-capability-badge is-level">
              {t("settings.capabilityFilterGlobal")}
            </span>
            {skill.source === "imported" ? (
              <span className="agent-capability-badge">{t("settings.imported")}</span>
            ) : null}
          </>
        }
        description={skill.description || t("settings.noCapabilityDescription")}
        actions={
          <>
            <TooltipButton
              type="button"
              className="settings-icon-button"
              ariaLabel={t("extensions.skills.rowActions", { name })}
              tooltip={t("extensions.skills.edit")}
              disabled={busy}
              onClick={() => void openEdit(skill, "global")}
            >
              <IconPencil size={15} />
            </TooltipButton>
            <CapabilityRowMenu
              label={t("extensions.skills.rowActions", { name })}
              items={items}
              disabled={busy}
              open={menuFor === key}
              onOpenChange={(open) => {
                setMenuFor(open ? key : null);
                if (!open) setArmed(null);
              }}
            />
            <CapabilityToggle
              checked={skill.enabled}
              busy={busy}
              label={t("settings.toggleCapability", { name })}
              onChange={() => void toggle(skill, "global")}
            />
          </>
        }
      />
    );
  };

  const renderProjectContextRow = (skill: ManagedUserSkill) => {
    // Project management borrows the global document: the switch writes a
    // per-project override only, and content stays in Global management.
    const key = `context:${skill.id}`;
    const name = skill.name || skill.id;
    const busy = busyId === rowKey("global", skill.id);
    const overridden = isSkillOverrideForProject(skill);
    return (
      <CapabilityRow
        key={key}
        glyph={<IconBookOpen size={16} />}
        name={name}
        off={!skill.enabled}
        badges={
          <>
            <span className="agent-capability-badge is-level">
              {t("settings.capabilityFilterGlobal")}
            </span>
            <span className="agent-capability-badge">
              {overridden
                ? t("settings.skillOverriddenForProject")
                : t("settings.skillInheritedFromGlobal")}
            </span>
          </>
        }
        description={skill.description || t("settings.noCapabilityDescription")}
        meta={
          <span className="agent-capability-hint">
            {t("settings.skillGlobalReadOnlyHint")}
          </span>
        }
        actions={
          <>
            {overridden ? (
              <CapabilityButton
                busy={busy}
                title={t("settings.skillRestoreInheritance")}
                onClick={() => void resetInheritance(skill)}
              >
                {t("settings.skillRestoreInheritance")}
              </CapabilityButton>
            ) : null}
            <CapabilityButton onClick={goGlobal}>
              {t("settings.skillOpenInGlobal")}
            </CapabilityButton>
            <CapabilityToggle
              checked={skill.enabled}
              busy={busy}
              label={t("settings.toggleCapability", { name })}
              onChange={() => void toggle(skill, "global")}
            />
          </>
        }
      />
    );
  };

  const renderProjectRow = (skill: ManagedUserSkill) => {
    const key = rowKey("project", skill.id);
    const name = skill.name || skill.id;
    const busy = busyId === key;
    const isArmed = armed === key;
    const items: CapabilityMenuItem[] = [
      {
        key: "reveal",
        label: t("extensions.skills.reveal"),
        icon: <IconFolderOpen size={14} />,
        onSelect: () => {
          setMenuFor(null);
          void reveal(skill, "project");
        },
      },
      {
        key: "move",
        label: t("settings.capabilityMoveToGlobal"),
        icon: <IconArrowUpDown size={14} />,
        onSelect: () => {
          setMenuFor(null);
          void moveToGlobal(skill);
        },
      },
      {
        key: "remove",
        label: isArmed ? t("settings.capabilityRemoveConfirm") : t("extensions.skills.remove"),
        icon: <IconTrash size={14} />,
        danger: true,
        onSelect: () => {
          if (isArmed) {
            setMenuFor(null);
            void remove(skill, "project");
          } else {
            setArmed(key);
          }
        },
      },
    ];
    return (
      <CapabilityRow
        key={key}
        glyph={<IconBookOpen size={16} />}
        name={name}
        off={!skill.enabled}
        menuOpen={menuFor === key}
        badges={
          <>
            <span className="agent-capability-badge is-level">
              {t("settings.capabilityFilterProject")}
            </span>
            {skill.source === "imported" ? (
              <span className="agent-capability-badge">{t("settings.imported")}</span>
            ) : null}
          </>
        }
        description={skill.description || t("settings.noCapabilityDescription")}
        actions={
          <>
            <TooltipButton
              type="button"
              className="settings-icon-button"
              ariaLabel={t("extensions.skills.rowActions", { name })}
              tooltip={t("extensions.skills.edit")}
              disabled={busy}
              onClick={() => void openEdit(skill, "project")}
            >
              <IconPencil size={15} />
            </TooltipButton>
            <CapabilityRowMenu
              label={t("extensions.skills.rowActions", { name })}
              items={items}
              disabled={busy}
              open={menuFor === key}
              onOpenChange={(open) => {
                setMenuFor(open ? key : null);
                if (!open) setArmed(null);
              }}
            />
            <CapabilityToggle
              checked={skill.enabled}
              busy={busy}
              label={t("settings.toggleCapability", { name })}
              onChange={() => void toggle(skill, "project")}
            />
          </>
        }
      />
    );
  };

  return (
    <AgentCapabilityPage
      toolbar={
        <CapabilityToolbar
          modeSwitch={
            <SegmentedControl
              value={mode}
              onChange={setMode}
              options={modeSegments}
              label={t("settings.skillsManageModeLabel")}
              className="agent-capability-segment"
              itemClassName="agent-capability-segment-btn"
            />
          }
          search={search}
          onSearchChange={setSearch}
          searchPlaceholder={t("extensions.skills.searchPlaceholder")}
          projectPicker={
            isProjectMode ? (
              <AgentProjectPicker
                value={selectedProjectPath}
                options={options}
                label={t("settings.selectProject")}
                onChange={setSelectedProjectPath}
              />
            ) : undefined
          }
          actions={
            <>
              <ImportToggleButton
                open={importOpen}
                controls="agent-skills-import-panel"
                label={t("settings.importSkillFromTools")}
                 disabled={!destination.ok}
                onClick={() => setImportOpen((current) => !current)}
              />
              <CapabilityButton variant="primary" title={newSkillTitle} onClick={openCreate}>
                <IconPlus size={14} />
                {t("settings.newSkill")}
              </CapabilityButton>
              {marketButton}
            </>
          }
        />
      }
    >
      <p className="agent-capability-scope-note">
        {isProjectMode ? t("settings.skillsProjectModeDesc") : t("settings.skillsGlobalModeDesc")}
      </p>
      <section
        id="agent-skills-import-panel"
        className="settings-card-block import-inline-section"
        hidden={!importOpen}
      >
        <div className="settings-card-heading-line">
          <h3 className="settings-card-heading">
            {t("settings.importAgentSkillsTitle")}
          </h3>
        </div>
        <div className="import-inline-workbench">
          {destination.ok ? (
            <AgentSkillImportPanel
              key={`${destination.level}:${destination.level === "project" ? destination.projectPath : ""}`}
              level={destination.level}
              projectPath={
                destination.level === "project" ? destination.projectPath : undefined
              }
              onImported={load}
            />
          ) : null}
        </div>
      </section>

      {moveDestinationFor ? (
        <section
          className="settings-card-block"
          role="dialog"
          aria-modal={false}
          aria-labelledby="agent-skills-move-title"
        >
           <div className="settings-card-heading-line">
             <h3 id="agent-skills-move-title" className="settings-card-heading">
               {t("settings.skillMoveTitle", {
                 name: moveDestinationFor.name || moveDestinationFor.id,
               })}
             </h3>
           </div>
          <div className="agent-capability-move-picker">
            <SettingsMenuSelect
              label={t("settings.skillMoveDestinationLabel")}
              value={moveProjectChoice}
              onChange={setMoveProjectChoice}
              options={options.map((project) => ({
                id: project.path,
                label: project.name,
              }))}
            />
            <CapabilityButton
              variant="primary"
              disabled={!moveProjectChoice || busyId === rowKey("global", moveDestinationFor.id)}
              busy={busyId === rowKey("global", moveDestinationFor.id)}
              onClick={() => void confirmMoveToProject(moveProjectChoice)}
            >
               {t("settings.skillMoveConfirm")}
            </CapabilityButton>
            <CapabilityButton onClick={() => setMoveDestinationFor(null)}>
              {t("common.cancel")}
            </CapabilityButton>
          </div>
        </section>
      ) : null}

      <CapabilityPanel
        loading={loading}
        refreshing={refreshing}
        loadingLabel={t("settings.loadingCapabilities")}
      >
        {counts.global + counts.project === 0 && search.trim() ? (
          <CapabilityEmpty
            message={t("settings.capabilityNoMatches")}
            icon={<IconBookOpen size={18} />}
          />
        ) : !isProjectMode ? (
          <>
            <CapabilityGroupHeader
              label={t("settings.builtinSkills")}
              count={visible.builtins.length}
            />
            {visible.builtins.map((skill) => renderBuiltinRow(skill, true))}
            <CapabilityGroupHeader
              label={t("settings.globalLevel")}
              path={SKILLS_GLOBAL_PATH}
              count={visible.global.length}
              action={importButton("global", true)}
            />
            {visible.global.length === 0 ? (
              <CapabilityEmpty
                message={t("settings.skillsEmpty")}
                icon={<IconBookOpen size={18} />}
                action={
                  <CapabilityButton variant="primary" onClick={openCreate}>
                    <IconPlus size={14} />
                    {t("extensions.skills.add")}
                  </CapabilityButton>
                }
              />
            ) : (
              visible.global.map(renderGlobalRow)
            )}
          </>
        ) : (
          <>
            <CapabilityGroupHeader
              label={t("settings.projectLevel")}
              path={projectSkillsPath(selectedProjectPath)}
              count={visible.project.length}
              action={
                selectedProjectPath ? importButton("project", true) : undefined
              }
            />
            {!selectedProjectPath ? (
              <CapabilityEmpty message={t("settings.skillsSelectProjectToManage")} />
            ) : visible.project.length === 0 ? (
              <CapabilityEmpty
                message={t("settings.skillsEmpty")}
                icon={<IconBookOpen size={18} />}
              />
            ) : (
              visible.project.map(renderProjectRow)
            )}
            <CapabilityGroupHeader
              label={
                selectedProjectPath
                  ? t("settings.skillsGlobalForProject", {
                      project: projectName ?? projectDisplayName(selectedProjectPath),
                    })
                  : t("settings.globalLevel")
              }
              path={SKILLS_GLOBAL_PATH}
              count={visible.global.length}
            />
            {visible.global.map(renderProjectContextRow)}
            <CapabilityGroupHeader
              label={t("settings.builtinSkills")}
              count={visible.builtins.length}
            />
            {visible.builtins.map((skill) => renderBuiltinRow(skill, false))}
          </>
        )}
      </CapabilityPanel>

      {editor ? (
        <SkillEditorSheet
          draft={editor.draft}
          setDraft={(draft) => setEditor((current) => (current ? { ...current, draft } : current))}
          editing={editor.editing}
          saving={saving}
          level={editor.level}
          projectName={projectName}
          onClose={closeEditor}
          onSave={() => void saveEditor()}
          onReveal={
            editor.editing
              ? () => void reveal(editor.editing!, editor.level)
              : undefined
          }
        />
      ) : null}
    </AgentCapabilityPage>
  );
}

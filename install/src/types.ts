export interface InstallOptions {
  default_agent?: string;
  mcp?: Record<string, boolean>;
  plugin?: Record<string, boolean>;
  tiers?: Record<string, string>;
  // true (default) = register global command shims (ocp / opencode-prime)
  // into ~/.local/bin and ensure that directory is on the
  // user's PATH; false = skip global command registration entirely.
  global_commands?: boolean;
  // How `ocp tui` starts:
  //   "direct"           — launch opencode directly in the current terminal
  //   "herdr" (default)  — launch a herdr workspace rooted at cwd (equivalent
  //                        to `ocp herdr`); auto-enables tools.herdr
  tui_mode?: "direct" | "herdr";
  // Generic opt-in map for tools declared in install/tools.jsonc.
  //   tools.<name>: true  → provision when missing (default if omitted)
  //   tools.<name>: false → user opted out, installer leaves it alone
  //   tools.<name> omitted → treat as enabled (default-true)
  // Adding a new tool = add an entry to install/tools.jsonc. The rtk plugin
  // cleanup in installer/merger.ts is the one side effect still wired by
  // name — it reads `tools.rtk === false` and removes `plugins/rtk-write*`
  // from the target.
  tools?: Record<string, boolean>;
}

export type CommandAction =
  | "install"
  | "update"
  | "upgrade"
  | "status"
  | "init"
  | "uninstall"
  | "register"
  | "unregister"
  | "wizard"
  | "dashboard"
  | "tui"
  | "serve"
  | "web"
  | "code"
  | "desktop"
  | "session"
  | "session-projects"
  | "auth"
  | "clean"
  | "herdr"
  | "herdr-config-install"
  | "herdr-config-path"
  | "herdr-config-status"
  | "project-init"
  | "project-index"
  | "project-sync"
  | "project-setup"
  | "provider"
  | "profile"
  | "usage";

export interface CliArgs {
  action: CommandAction;
  target?: string;
  force: boolean;
  noBackup: boolean;
  // Max backup directories kept beside the target after each run.
  // Unset = OCP_MAX_BACKUPS env, else 5 (see installer.getMaxBackups).
  keepBackups?: number;
  yes: boolean;
  projectMode: "auto" | "wizard" | "headless";
  binDir?: string;
  optionsFile?: string;
  isInteractive: boolean;
  // Arguments forwarded verbatim to the launched binary (`tui` / `desktop`).
  passthrough?: string[];
  // `clean` subcommand options.
  cleanDays?: number;
  cleanAll?: boolean;
  // Explicitly allow clean to span every saved workspace/project.
  cleanAllProjects?: boolean;
  cleanDryRun?: boolean;
  cleanIncludeSubagents?: boolean;
  cleanProject?: string;
  cleanProjectName?: string;
  cleanDirectory?: string;
}

export interface ManifestData {
  version: string;
  files: string[];
}

export interface PreserveBag {
  profiles: Record<string, string>;
  userAgents: Record<string, any>;
  userModels: Record<string, any>;
  userEnv: Record<string, string>;
  userTiers: Record<string, string>;
  /** Root-level `model` the user picked (e.g. via /profile apply). */
  userModel?: string;
  /** Root-level `small_model` the user picked (tracks tier.flash). */
  userSmallModel?: string;
  /** Per-agent model overrides the user set on factory agents. */
  userAgentModels?: Record<string, string>;
}

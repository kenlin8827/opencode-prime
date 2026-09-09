import { runOcpUi } from './ui/runtime'

/** Project setup now uses the shared OpenTUI surface; project operations remain shared cores. */
export async function runProjectWizard(root: string, repoDir: string): Promise<number> {
  // `root` is the project being configured; `repoDir` is OCP's installation
  // root, where the OpenTUI runtime and wizard modules live. They differ when
  // a user runs `ocp project` from an arbitrary repository (or $HOME).
  return (await runOcpUi('project', { repoDir, root })).code
}

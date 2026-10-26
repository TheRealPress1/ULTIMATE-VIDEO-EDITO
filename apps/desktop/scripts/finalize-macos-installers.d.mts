export function finalizeMacInstallers(artifacts: string[], env?: NodeJS.ProcessEnv, services?: {
  run: (command: string, args: string[]) => Promise<unknown>;
  notarize: (options: { appPath: string; keychainProfile?: string; keychain?: string; appleId?: string; appleIdPassword?: string; teamId?: string }) => Promise<unknown>;
}): Promise<void>;

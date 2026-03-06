/** Options for vault operations. */
export interface VaultOptions {
  /** Project root directory. Default: process.cwd() */
  cwd?: string;
  /** GPG passphrase override. Default: FIO_VAULT_PASSPHRASE env var */
  passphrase?: string;
}

/** Status of a single secret in the vault. */
export interface KeyStatus {
  key: string;
  envVar: string;
  exists: boolean;
}

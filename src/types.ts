/** Options for vault operations. */
export interface VaultOptions {
  /** Project root directory. Default: process.cwd() */
  cwd?: string;
  /** GPG passphrase override. Default: FIO_VAULT_PASSPHRASE env var */
  passphrase?: string;
  /** Include global vault (~/.fio-vault/) as fallback. Default: true */
  global?: boolean;
}

/** Status of a single secret in the vault. */
export interface KeyStatus {
  key: string;
  envVar: string;
  exists: boolean;
  /** Where the secret was resolved from. */
  source: "project" | "global";
}

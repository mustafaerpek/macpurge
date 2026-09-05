export const SCHEMA_VERSION = 1 as const;

export type InstallSource = "standalone" | "homebrew" | "app-store" | "pkg" | "unknown";
export type RiskClass = "confirmed" | "possible" | "protected";
export type CandidateKind =
  | "application"
  | "application-support"
  | "cache"
  | "preference"
  | "http-storage"
  | "saved-state"
  | "log"
  | "container"
  | "cli-symlink"
  | "launch-agent"
  | "launch-daemon"
  | "privileged-helper"
  | "temporary"
  | "package-payload"
  | "other";

export interface AppIdentity {
  displayName: string;
  bundleId: string;
  teamId?: string;
  version?: string;
  path: string;
  installSource: InstallSource;
  managerId?: string;
  packageReceipts: string[];
}

export interface Evidence {
  source: "identity" | "standard-path" | "spotlight" | "deep-scan" | "symlink" | "rule" | "receipt";
  detail: string;
}

export interface Candidate {
  id: string;
  path: string;
  realPath?: string;
  kind: CandidateKind;
  risk: RiskClass;
  evidence: Evidence[];
  sizeBytes: number;
  owner?: string;
  group?: string;
  mode?: string;
  requiresAdmin: boolean;
  selectedByDefault: boolean;
}

export interface DeferredAction {
  type: "keychain" | "tcc" | "preferences-domain" | "login-item" | "pkg-receipt" | "homebrew-cask";
  value: string;
  description: string;
  requiresAdmin: boolean;
}

export type SessionStatus =
  | "planned"
  | "quarantining"
  | "quarantined"
  | "partial"
  | "restored"
  | "purging"
  | "purged"
  | "failed";

export type ItemStatus = "pending" | "moved" | "restored" | "purged" | "failed";

export interface SessionItem {
  candidate: Candidate;
  originalPath: string;
  quarantinePath: string;
  status: ItemStatus;
  error?: string;
}

export interface SessionManifest {
  schemaVersion: typeof SCHEMA_VERSION;
  id: string;
  createdAt: string;
  updatedAt: string;
  status: SessionStatus;
  app: AppIdentity;
  items: SessionItem[];
  deferredActions: DeferredAction[];
  warnings: string[];
  errors: string[];
}

export interface ScanResult {
  schemaVersion: typeof SCHEMA_VERSION;
  status: "clean" | "found";
  app: AppIdentity;
  candidates: Candidate[];
  deferredActions: DeferredAction[];
  warnings: string[];
  errors: string[];
}

export interface RuleCandidate {
  pathTemplate: string;
  match?: "exact" | "prefix";
  kind: CandidateKind;
  risk: RiskClass;
  reason: string;
  requiresSymlinkIntoApp?: boolean;
}

export interface RuleProfile {
  schemaVersion: typeof SCHEMA_VERSION;
  id: string;
  bundleIds: string[];
  platform?: "darwin";
  candidates: RuleCandidate[];
  /** Set during validation: built-in rules ship with the binary, user rules are untrusted input. */
  origin: "builtin" | "user";
}

export interface SystemPaths {
  home: string;
  applications: string;
  userApplications: string;
  userLibrary: string;
  systemLibrary: string;
  temp: string;
  supportRoot: string;
  quarantineRoot: string;
  sessionRoot: string;
  userRuleRoot: string;
  binRoots: string[];
}

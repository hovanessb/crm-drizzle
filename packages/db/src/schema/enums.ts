export const McpConnectionStatus = {
	CONNECTING: "CONNECTING",
	CONNECTED: "CONNECTED",
	ERROR: "ERROR",
	DISCONNECTED: "DISCONNECTED",
} as const;

export type McpConnectionStatus =
	(typeof McpConnectionStatus)[keyof typeof McpConnectionStatus];

export const McpAccessMode = {
	READ_ONLY: "READ_ONLY",
	READ_WRITE: "READ_WRITE",
} as const;

export type McpAccessMode = (typeof McpAccessMode)[keyof typeof McpAccessMode];

export const McpToolReviewState = {
	PENDING: "PENDING",
	REVIEWED: "REVIEWED",
	CHANGED: "CHANGED",
	REMOVED: "REMOVED",
} as const;

export type McpToolReviewState =
	(typeof McpToolReviewState)[keyof typeof McpToolReviewState];

export const DealStage = {
	DEMO_BOOKED: "DEMO_BOOKED",
	QUALIFIED_TO_BUY: "QUALIFIED_TO_BUY",
	UNQUALIFIED_TO_BUY: "UNQUALIFIED_TO_BUY",
	DECISION_MAKER_BOUGHT_IN: "DECISION_MAKER_BOUGHT_IN",
	CONTRACT_SENT: "CONTRACT_SENT",
	CLOSED_WON: "CLOSED_WON",
	CLOSED_LOST: "CLOSED_LOST",
} as const;

export type DealStage = (typeof DealStage)[keyof typeof DealStage];

export const ActivityType = {
	NOTE: "NOTE",
	CALL: "CALL",
	EMAIL: "EMAIL",
	MEETING: "MEETING",
	TASK: "TASK",
	STAGE_CHANGE: "STAGE_CHANGE",
	ENRICHMENT: "ENRICHMENT",
} as const;

export type ActivityType = (typeof ActivityType)[keyof typeof ActivityType];

export const EnrichmentStatus = {
	PENDING: "PENDING",
	RUNNING: "RUNNING",
	COMPLETE: "COMPLETE",
	FAILED: "FAILED",
	SKIPPED: "SKIPPED",
} as const;

export type EnrichmentStatus =
	(typeof EnrichmentStatus)[keyof typeof EnrichmentStatus];

export const RecordSource = {
	MANUAL: "MANUAL",
	IMPORT: "IMPORT",
	EMAIL: "EMAIL",
	CALENDAR: "CALENDAR",
	TRACKING: "TRACKING",
} as const;

export type RecordSource = (typeof RecordSource)[keyof typeof RecordSource];

export const AgentConversationKind = {
	RECORD: "RECORD",
	BUILDER: "BUILDER",
} as const;

export type AgentConversationKind =
	(typeof AgentConversationKind)[keyof typeof AgentConversationKind];

export const AgentDefinitionStatus = {
	DRAFT: "DRAFT",
	DEPLOYING: "DEPLOYING",
	LIVE: "LIVE",
	PAUSED: "PAUSED",
	ARCHIVED: "ARCHIVED",
	DELETED: "DELETED",
} as const;

export type AgentDefinitionStatus =
	(typeof AgentDefinitionStatus)[keyof typeof AgentDefinitionStatus];

export const AgentVersionStatus = {
	DRAFT: "DRAFT",
	VALIDATING: "VALIDATING",
	READY: "READY",
	DEPLOYED: "DEPLOYED",
	REJECTED: "REJECTED",
} as const;

export type AgentVersionStatus =
	(typeof AgentVersionStatus)[keyof typeof AgentVersionStatus];

export const AgentBuilderArtifactStatus = {
	WRITING: "WRITING",
	READY: "READY",
} as const;

export type AgentBuilderArtifactStatus =
	(typeof AgentBuilderArtifactStatus)[keyof typeof AgentBuilderArtifactStatus];

export const AgentTriggerType = {
	MANUAL: "MANUAL",
	SCHEDULE: "SCHEDULE",
	EVENT: "EVENT",
	WEBHOOK: "WEBHOOK",
} as const;

export type AgentTriggerType =
	(typeof AgentTriggerType)[keyof typeof AgentTriggerType];

export const AgentRunStatus = {
	QUEUED: "QUEUED",
	RUNNING: "RUNNING",
	WAITING_FOR_APPROVAL: "WAITING_FOR_APPROVAL",
	SUCCEEDED: "SUCCEEDED",
	FAILED: "FAILED",
	CANCELLED: "CANCELLED",
} as const;

export type AgentRunStatus =
	(typeof AgentRunStatus)[keyof typeof AgentRunStatus];

export const AgentActionStatus = {
	PLANNED: "PLANNED",
	RUNNING: "RUNNING",
	SUCCEEDED: "SUCCEEDED",
	FAILED: "FAILED",
	CANCELLED: "CANCELLED",
} as const;

export type AgentActionStatus =
	(typeof AgentActionStatus)[keyof typeof AgentActionStatus];

export const AgentConversationShareScope = {
	WORKSPACE_LINK: "WORKSPACE_LINK",
} as const;

export type AgentConversationShareScope =
	(typeof AgentConversationShareScope)[keyof typeof AgentConversationShareScope];

export const AgentConversationSubmissionStatus = {
	PENDING: "PENDING",
	SENDING: "SENDING",
	ACCEPTED: "ACCEPTED",
	FAILED: "FAILED",
	CANCELLED: "CANCELLED",
} as const;

export type AgentConversationSubmissionStatus =
	(typeof AgentConversationSubmissionStatus)[keyof typeof AgentConversationSubmissionStatus];

export const AgentConversationCommandType = {
	CHAT: "CHAT",
	CREATE_AGENT: "CREATE_AGENT",
} as const;

export type AgentConversationCommandType =
	(typeof AgentConversationCommandType)[keyof typeof AgentConversationCommandType];

export const AgentConversationPermissionMode = {
	MANUAL: "MANUAL",
	AUTO: "AUTO",
	BYPASS: "BYPASS",
} as const;

export type AgentConversationPermissionMode =
	(typeof AgentConversationPermissionMode)[keyof typeof AgentConversationPermissionMode];

export const AgentResponseRating = {
	UP: "UP",
	DOWN: "DOWN",
} as const;

export type AgentResponseRating =
	(typeof AgentResponseRating)[keyof typeof AgentResponseRating];

export const FactBand = {
	VERIFIED: "VERIFIED",
	PROBABLE: "PROBABLE",
	POSSIBLE: "POSSIBLE",
} as const;

export type FactBand = (typeof FactBand)[keyof typeof FactBand];

export const FactStatus = {
	APPLIED: "APPLIED",
	PROPOSED: "PROPOSED",
	DISMISSED: "DISMISSED",
	SUPERSEDED: "SUPERSEDED",
} as const;

export type FactStatus = (typeof FactStatus)[keyof typeof FactStatus];

export const RateSource = {
	FETCHED: "FETCHED",
	MANUAL: "MANUAL",
} as const;

export type RateSource = (typeof RateSource)[keyof typeof RateSource];

export const FieldEntity = {
	COMPANY: "COMPANY",
	CONTACT: "CONTACT",
	DEAL: "DEAL",
} as const;

export type FieldEntity = (typeof FieldEntity)[keyof typeof FieldEntity];

export const FieldType = {
	TEXT: "TEXT",
	LONG_TEXT: "LONG_TEXT",
	NUMBER: "NUMBER",
	DATE: "DATE",
	CHECKBOX: "CHECKBOX",
	SELECT: "SELECT",
	URL: "URL",
	EMAIL: "EMAIL",
	PHONE: "PHONE",
	USER: "USER",
} as const;

export type FieldType = (typeof FieldType)[keyof typeof FieldType];

export const GoogleSyncStatus = {
	IDLE: "IDLE",
	RUNNING: "RUNNING",
	NEEDS_RECONNECT: "NEEDS_RECONNECT",
	FAILED: "FAILED",
} as const;

export type GoogleSyncStatus =
	(typeof GoogleSyncStatus)[keyof typeof GoogleSyncStatus];

export const EmailDirection = {
	INBOUND: "INBOUND",
	OUTBOUND: "OUTBOUND",
} as const;

export type EmailDirection =
	(typeof EmailDirection)[keyof typeof EmailDirection];

export const DomainScope = {
	SITE_AND_SUBDOMAINS: "SITE_AND_SUBDOMAINS",
	EXACT_HOST: "EXACT_HOST",
} as const;

export type DomainScope = (typeof DomainScope)[keyof typeof DomainScope];

CREATE TYPE "public"."ActivityType" AS ENUM('NOTE', 'CALL', 'EMAIL', 'MEETING', 'TASK', 'STAGE_CHANGE', 'ENRICHMENT');
--> statement-breakpoint
CREATE TYPE "public"."AgentActionStatus" AS ENUM('PLANNED', 'RUNNING', 'SUCCEEDED', 'FAILED', 'CANCELLED');
--> statement-breakpoint
CREATE TYPE "public"."AgentBuilderArtifactStatus" AS ENUM('WRITING', 'READY');
--> statement-breakpoint
CREATE TYPE "public"."AgentConversationCommandType" AS ENUM('CHAT', 'CREATE_AGENT');
--> statement-breakpoint
CREATE TYPE "public"."AgentConversationKind" AS ENUM('RECORD', 'BUILDER');
--> statement-breakpoint
CREATE TYPE "public"."AgentConversationPermissionMode" AS ENUM('MANUAL', 'AUTO', 'BYPASS');
--> statement-breakpoint
CREATE TYPE "public"."AgentConversationShareScope" AS ENUM('WORKSPACE_LINK');
--> statement-breakpoint
CREATE TYPE "public"."AgentConversationSubmissionStatus" AS ENUM('PENDING', 'SENDING', 'ACCEPTED', 'FAILED', 'CANCELLED');
--> statement-breakpoint
CREATE TYPE "public"."AgentDefinitionStatus" AS ENUM('DRAFT', 'DEPLOYING', 'LIVE', 'PAUSED', 'ARCHIVED', 'DELETED');
--> statement-breakpoint
CREATE TYPE "public"."AgentResponseRating" AS ENUM('UP', 'DOWN');
--> statement-breakpoint
CREATE TYPE "public"."AgentRunStatus" AS ENUM('QUEUED', 'RUNNING', 'WAITING_FOR_APPROVAL', 'SUCCEEDED', 'FAILED', 'CANCELLED');
--> statement-breakpoint
CREATE TYPE "public"."AgentTriggerType" AS ENUM('MANUAL', 'SCHEDULE', 'EVENT', 'WEBHOOK');
--> statement-breakpoint
CREATE TYPE "public"."AgentVersionStatus" AS ENUM('DRAFT', 'VALIDATING', 'READY', 'DEPLOYED', 'REJECTED');
--> statement-breakpoint
CREATE TYPE "public"."DealStage" AS ENUM('DEMO_BOOKED', 'QUALIFIED_TO_BUY', 'UNQUALIFIED_TO_BUY', 'DECISION_MAKER_BOUGHT_IN', 'CONTRACT_SENT', 'CLOSED_WON', 'CLOSED_LOST');
--> statement-breakpoint
CREATE TYPE "public"."DomainScope" AS ENUM('SITE_AND_SUBDOMAINS', 'EXACT_HOST');
--> statement-breakpoint
CREATE TYPE "public"."EmailDirection" AS ENUM('INBOUND', 'OUTBOUND');
--> statement-breakpoint
CREATE TYPE "public"."EnrichmentStatus" AS ENUM('PENDING', 'RUNNING', 'COMPLETE', 'FAILED', 'SKIPPED');
--> statement-breakpoint
CREATE TYPE "public"."FactBand" AS ENUM('VERIFIED', 'PROBABLE', 'POSSIBLE');
--> statement-breakpoint
CREATE TYPE "public"."FactStatus" AS ENUM('APPLIED', 'PROPOSED', 'DISMISSED', 'SUPERSEDED');
--> statement-breakpoint
CREATE TYPE "public"."FieldEntity" AS ENUM('COMPANY', 'CONTACT', 'DEAL');
--> statement-breakpoint
CREATE TYPE "public"."FieldType" AS ENUM('TEXT', 'LONG_TEXT', 'NUMBER', 'DATE', 'CHECKBOX', 'SELECT', 'URL', 'EMAIL', 'PHONE', 'USER');
--> statement-breakpoint
CREATE TYPE "public"."GoogleSyncStatus" AS ENUM('IDLE', 'RUNNING', 'NEEDS_RECONNECT', 'FAILED');
--> statement-breakpoint
CREATE TYPE "public"."McpAccessMode" AS ENUM('READ_ONLY', 'READ_WRITE');
--> statement-breakpoint
CREATE TYPE "public"."McpConnectionStatus" AS ENUM('CONNECTING', 'CONNECTED', 'ERROR', 'DISCONNECTED');
--> statement-breakpoint
CREATE TYPE "public"."McpToolReviewState" AS ENUM('PENDING', 'REVIEWED', 'CHANGED', 'REMOVED');
--> statement-breakpoint
CREATE TYPE "public"."RateSource" AS ENUM('FETCHED', 'MANUAL');
--> statement-breakpoint
CREATE TYPE "public"."RecordSource" AS ENUM('MANUAL', 'IMPORT', 'EMAIL', 'CALENDAR', 'TRACKING');
--> statement-breakpoint
CREATE TABLE "account" (
	"id" text PRIMARY KEY NOT NULL,
	"accountId" text NOT NULL,
	"providerId" text NOT NULL,
	"userId" text NOT NULL,
	"accessToken" text,
	"refreshToken" text,
	"idToken" text,
	"accessTokenExpiresAt" timestamp (3),
	"refreshTokenExpiresAt" timestamp (3),
	"scope" text,
	"password" text,
	"createdAt" timestamp (3) DEFAULT CURRENT_TIMESTAMP NOT NULL,
	"updatedAt" timestamp (3) NOT NULL
);
--> statement-breakpoint
CREATE TABLE "activity" (
	"id" text PRIMARY KEY NOT NULL,
	"type" "ActivityType" NOT NULL,
	"subject" text,
	"body" text,
	"occurredAt" timestamp (3),
	"dueAt" timestamp (3),
	"completedAt" timestamp (3),
	"companyId" text,
	"contactId" text,
	"dealId" text,
	"createdById" text NOT NULL,
	"meta" jsonb,
	"emailThreadId" text,
	"calendarEventId" text,
	"createdAt" timestamp (3) DEFAULT CURRENT_TIMESTAMP NOT NULL,
	"updatedAt" timestamp (3) NOT NULL
);
--> statement-breakpoint
CREATE TABLE "agentAction" (
	"id" text PRIMARY KEY NOT NULL,
	"agentId" text NOT NULL,
	"runId" text NOT NULL,
	"type" text NOT NULL,
	"provider" text NOT NULL,
	"targetType" text,
	"targetId" text,
	"targetLabel" text,
	"summary" text NOT NULL,
	"metadata" jsonb,
	"status" "AgentActionStatus" DEFAULT 'PLANNED' NOT NULL,
	"idempotencyKey" text NOT NULL,
	"requestHash" text,
	"externalId" text,
	"attemptCount" integer DEFAULT 0 NOT NULL,
	"errorCode" text,
	"errorMessage" text,
	"plannedAt" timestamp (3) DEFAULT CURRENT_TIMESTAMP NOT NULL,
	"startedAt" timestamp (3),
	"completedAt" timestamp (3),
	"updatedAt" timestamp (3) NOT NULL
);
--> statement-breakpoint
CREATE TABLE "agentAuditEvent" (
	"id" text PRIMARY KEY NOT NULL,
	"agentId" text NOT NULL,
	"versionId" text,
	"actorUserId" text,
	"type" text NOT NULL,
	"actorType" text NOT NULL,
	"actorId" text,
	"summary" text NOT NULL,
	"before" jsonb,
	"after" jsonb,
	"requestId" text,
	"emittedAt" timestamp (3) DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE TABLE "agentBuilderArtifact" (
	"id" text PRIMARY KEY NOT NULL,
	"conversationId" text,
	"versionId" text,
	"path" text NOT NULL,
	"language" text NOT NULL,
	"content" text NOT NULL,
	"previousContent" text,
	"revision" integer NOT NULL,
	"status" "AgentBuilderArtifactStatus" DEFAULT 'WRITING' NOT NULL,
	"createdAt" timestamp (3) DEFAULT CURRENT_TIMESTAMP NOT NULL,
	CONSTRAINT "agentBuilderArtifact_owner_present" CHECK ("agentBuilderArtifact"."conversationId" IS NOT NULL OR "agentBuilderArtifact"."versionId" IS NOT NULL)
);
--> statement-breakpoint
CREATE TABLE "agentConversation" (
	"id" text PRIMARY KEY NOT NULL,
	"kind" "AgentConversationKind" DEFAULT 'RECORD' NOT NULL,
	"contactId" text,
	"companyId" text,
	"dealId" text,
	"userId" text NOT NULL,
	"agentId" text,
	"sessionId" text,
	"continuationToken" text,
	"streamIndex" integer DEFAULT 0 NOT NULL,
	"pendingInputRequests" jsonb,
	"permissionMode" "AgentConversationPermissionMode" DEFAULT 'MANUAL' NOT NULL,
	"title" text,
	"messageCount" integer DEFAULT 0 NOT NULL,
	"createdAt" timestamp (3) DEFAULT CURRENT_TIMESTAMP NOT NULL,
	"updatedAt" timestamp (3) NOT NULL,
	"lastMessageAt" timestamp (3) DEFAULT CURRENT_TIMESTAMP NOT NULL,
	"lastAssistantAt" timestamp (3),
	"lastReadAt" timestamp (3)
);
--> statement-breakpoint
CREATE TABLE "agentConversationAttachment" (
	"id" text PRIMARY KEY NOT NULL,
	"submissionId" text NOT NULL,
	"name" text NOT NULL,
	"mediaType" text NOT NULL,
	"size" integer NOT NULL,
	"content" "bytea" NOT NULL,
	"position" integer NOT NULL,
	"createdAt" timestamp (3) DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE TABLE "agentConversationFeedback" (
	"id" text PRIMARY KEY NOT NULL,
	"conversationId" text NOT NULL,
	"userId" text NOT NULL,
	"messageId" text NOT NULL,
	"rating" "AgentResponseRating" NOT NULL,
	"createdAt" timestamp (3) DEFAULT CURRENT_TIMESTAMP NOT NULL,
	"updatedAt" timestamp (3) NOT NULL
);
--> statement-breakpoint
CREATE TABLE "agentConversationShare" (
	"id" text PRIMARY KEY NOT NULL,
	"conversationId" text NOT NULL,
	"createdById" text NOT NULL,
	"scope" "AgentConversationShareScope" DEFAULT 'WORKSPACE_LINK' NOT NULL,
	"tokenHash" text NOT NULL,
	"createdAt" timestamp (3) DEFAULT CURRENT_TIMESTAMP NOT NULL,
	"expiresAt" timestamp (3),
	"revokedAt" timestamp (3)
);
--> statement-breakpoint
CREATE TABLE "agentConversationSubmission" (
	"id" text PRIMARY KEY NOT NULL,
	"conversationId" text NOT NULL,
	"submittedById" text NOT NULL,
	"clientRequestId" text NOT NULL,
	"inputRequestId" text,
	"commandType" "AgentConversationCommandType" DEFAULT 'CHAT' NOT NULL,
	"message" jsonb NOT NULL,
	"status" "AgentConversationSubmissionStatus" DEFAULT 'PENDING' NOT NULL,
	"attemptCount" integer DEFAULT 0 NOT NULL,
	"errorCode" text,
	"errorMessage" text,
	"createdAt" timestamp (3) DEFAULT CURRENT_TIMESTAMP NOT NULL,
	"sentAt" timestamp (3),
	"acceptedAt" timestamp (3)
);
--> statement-breakpoint
CREATE TABLE "agentDefinition" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"status" "AgentDefinitionStatus" DEFAULT 'DRAFT' NOT NULL,
	"createdById" text NOT NULL,
	"currentVersionId" text,
	"createdAt" timestamp (3) DEFAULT CURRENT_TIMESTAMP NOT NULL,
	"updatedAt" timestamp (3) NOT NULL,
	"archivedAt" timestamp (3),
	"deletedAt" timestamp (3)
);
--> statement-breakpoint
CREATE TABLE "agentEvent" (
	"id" text PRIMARY KEY NOT NULL,
	"sessionId" text NOT NULL,
	"streamIndex" integer,
	"deliveryIds" text[] DEFAULT ARRAY[]::text[] NOT NULL,
	"contactId" text,
	"conversationId" text,
	"type" text NOT NULL,
	"data" jsonb NOT NULL,
	"encryptedData" text,
	"emittedAt" timestamp (3) NOT NULL
);
--> statement-breakpoint
CREATE TABLE "agentRun" (
	"id" text PRIMARY KEY NOT NULL,
	"agentId" text NOT NULL,
	"versionId" text NOT NULL,
	"triggerId" text,
	"initiatedById" text,
	"triggerType" "AgentTriggerType" NOT NULL,
	"status" "AgentRunStatus" DEFAULT 'QUEUED' NOT NULL,
	"principalId" text,
	"sessionId" text,
	"idempotencyKey" text NOT NULL,
	"correlationId" text NOT NULL,
	"input" jsonb,
	"result" jsonb,
	"summary" text,
	"modelId" text,
	"inputTokens" integer,
	"outputTokens" integer,
	"costUsd" numeric(12, 6),
	"errorCode" text,
	"errorMessage" text,
	"nextEventSequence" integer DEFAULT 0 NOT NULL,
	"createdAt" timestamp (3) DEFAULT CURRENT_TIMESTAMP NOT NULL,
	"startedAt" timestamp (3),
	"finishedAt" timestamp (3),
	"cancelRequestedAt" timestamp (3),
	"cancelDeliveredAt" timestamp (3)
);
--> statement-breakpoint
CREATE TABLE "agentRunEvent" (
	"id" text PRIMARY KEY NOT NULL,
	"runId" text NOT NULL,
	"sequence" integer NOT NULL,
	"type" text NOT NULL,
	"data" jsonb NOT NULL,
	"emittedAt" timestamp (3) DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE TABLE "agentTask" (
	"id" text PRIMARY KEY NOT NULL,
	"contactId" text,
	"companyId" text,
	"dealId" text,
	"kind" text NOT NULL,
	"reason" text NOT NULL,
	"payload" jsonb,
	"priority" integer DEFAULT 0 NOT NULL,
	"budget" integer DEFAULT 4 NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"dueAt" timestamp (3) NOT NULL,
	"leasedUntil" timestamp (3),
	"sessionId" text,
	"startedAt" timestamp (3),
	"finishedAt" timestamp (3),
	"outcome" text,
	"subject" text,
	"createdAt" timestamp (3) DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE TABLE "agentTrigger" (
	"id" text PRIMARY KEY NOT NULL,
	"agentId" text NOT NULL,
	"versionId" text NOT NULL,
	"type" "AgentTriggerType" NOT NULL,
	"name" text NOT NULL,
	"config" jsonb NOT NULL,
	"createdById" text NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"nextRunAt" timestamp (3),
	"lastRunAt" timestamp (3),
	"createdAt" timestamp (3) DEFAULT CURRENT_TIMESTAMP NOT NULL,
	"updatedAt" timestamp (3) NOT NULL
);
--> statement-breakpoint
CREATE TABLE "agentVersion" (
	"id" text PRIMARY KEY NOT NULL,
	"agentId" text NOT NULL,
	"number" integer NOT NULL,
	"status" "AgentVersionStatus" DEFAULT 'DRAFT' NOT NULL,
	"instructions" text NOT NULL,
	"manifest" jsonb NOT NULL,
	"modelId" text NOT NULL,
	"modelContextWindowTokens" integer DEFAULT 1000000 NOT NULL,
	"sandboxPolicy" jsonb NOT NULL,
	"validation" jsonb,
	"sourceConversationId" text,
	"createdById" text NOT NULL,
	"deploymentId" text,
	"approvedAt" timestamp (3),
	"deployedAt" timestamp (3),
	"createdAt" timestamp (3) DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE TABLE "apikey" (
	"id" text PRIMARY KEY NOT NULL,
	"configId" text DEFAULT 'default' NOT NULL,
	"name" text,
	"start" text,
	"referenceId" text NOT NULL,
	"prefix" text,
	"key" text NOT NULL,
	"refillInterval" integer,
	"refillAmount" integer,
	"lastRefillAt" timestamp (3),
	"enabled" boolean DEFAULT true,
	"rateLimitEnabled" boolean DEFAULT true,
	"rateLimitTimeWindow" integer,
	"rateLimitMax" integer,
	"requestCount" integer DEFAULT 0,
	"remaining" integer,
	"lastRequest" timestamp (3),
	"expiresAt" timestamp (3),
	"createdAt" timestamp (3) NOT NULL,
	"updatedAt" timestamp (3) NOT NULL,
	"permissions" text,
	"metadata" text
);
--> statement-breakpoint
CREATE TABLE "appSetting" (
	"id" text PRIMARY KEY NOT NULL,
	"agentModelId" text,
	"agentModelContextWindow" integer,
	"contextDevApiKey" text,
	"reportingCurrency" text,
	"ratesRefreshedAt" timestamp (3),
	"archiveRetentionDays" integer DEFAULT 180 NOT NULL,
	"trackingSiteId" text,
	"trackingCrossDomain" boolean DEFAULT true NOT NULL,
	"trackingLimitToDomains" boolean DEFAULT true NOT NULL,
	"trackingCookieSubdomains" boolean DEFAULT false NOT NULL,
	"trackingSecureCookies" boolean DEFAULT true NOT NULL,
	"trackingHonourDnt" boolean DEFAULT true NOT NULL,
	"trackingCookieDays" integer DEFAULT 395 NOT NULL,
	"trackingConfigHash" text,
	"trackingPaused" boolean DEFAULT false NOT NULL,
	"updatedAt" timestamp (3) NOT NULL
);
--> statement-breakpoint
CREATE TABLE "calendarAttendee" (
	"id" text PRIMARY KEY NOT NULL,
	"eventId" text NOT NULL,
	"email" text NOT NULL,
	"name" text,
	"responseStatus" text,
	"isOrganizer" boolean DEFAULT false NOT NULL,
	"contactId" text
);
--> statement-breakpoint
CREATE TABLE "calendarEvent" (
	"id" text PRIMARY KEY NOT NULL,
	"iCalUid" text NOT NULL,
	"originalStartTime" timestamp (3) NOT NULL,
	"recurringEventId" text,
	"title" text,
	"description" text,
	"location" text,
	"conferenceUrl" text,
	"startsAt" timestamp (3) NOT NULL,
	"endsAt" timestamp (3) NOT NULL,
	"isAllDay" boolean DEFAULT false NOT NULL,
	"status" text NOT NULL,
	"organizerEmail" text,
	"companyId" text,
	"contactId" text,
	"syncedByUserId" text,
	"googleEventId" text,
	"createdAt" timestamp (3) DEFAULT CURRENT_TIMESTAMP NOT NULL,
	"updatedAt" timestamp (3) NOT NULL
);
--> statement-breakpoint
CREATE TABLE "company" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"domain" text,
	"website" text,
	"description" text,
	"logoUrl" text,
	"logoDarkUrl" text,
	"iconUrl" text,
	"iconDarkUrl" text,
	"iconTone" text,
	"brandColor" text,
	"industry" text,
	"subIndustry" text,
	"city" text,
	"stateCode" text,
	"country" text,
	"countryCode" text,
	"phone" text,
	"email" text,
	"linkedinUrl" text,
	"twitterUrl" text,
	"githubUrl" text,
	"pricingUrl" text,
	"careersUrl" text,
	"ownerId" text,
	"primaryContactId" text,
	"enrichmentStatus" "EnrichmentStatus" DEFAULT 'PENDING' NOT NULL,
	"enrichedAt" timestamp (3),
	"enrichmentError" text,
	"source" "RecordSource" DEFAULT 'MANUAL' NOT NULL,
	"lastActivityAt" timestamp (3),
	"archivedAt" timestamp (3),
	"createdAt" timestamp (3) DEFAULT CURRENT_TIMESTAMP NOT NULL,
	"updatedAt" timestamp (3) NOT NULL
);
--> statement-breakpoint
CREATE TABLE "companyEnrichment" (
	"companyId" text PRIMARY KEY NOT NULL,
	"source" text DEFAULT 'context.dev' NOT NULL,
	"raw" jsonb NOT NULL,
	"fetchedAt" timestamp (3) DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE TABLE "contact" (
	"id" text PRIMARY KEY NOT NULL,
	"firstName" text NOT NULL,
	"lastName" text,
	"email" text,
	"phone" text,
	"title" text,
	"seniority" text,
	"function" text,
	"linkedinUrl" text,
	"twitterUrl" text,
	"githubUrl" text,
	"imageUrl" text,
	"socialsCheckedAt" timestamp (3),
	"enrichmentStatus" "EnrichmentStatus" DEFAULT 'PENDING' NOT NULL,
	"enrichedAt" timestamp (3),
	"enrichmentError" text,
	"companyId" text,
	"ownerId" text,
	"source" "RecordSource" DEFAULT 'MANUAL' NOT NULL,
	"lastActivityAt" timestamp (3),
	"archivedAt" timestamp (3),
	"createdAt" timestamp (3) DEFAULT CURRENT_TIMESTAMP NOT NULL,
	"updatedAt" timestamp (3) NOT NULL
);
--> statement-breakpoint
CREATE TABLE "contactBrief" (
	"contactId" text PRIMARY KEY NOT NULL,
	"narrative" text NOT NULL,
	"sections" jsonb NOT NULL,
	"score" double precision NOT NULL,
	"sourceUrl" text,
	"sessionId" text,
	"refreshedAt" timestamp (3) DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE TABLE "contactFact" (
	"id" text PRIMARY KEY NOT NULL,
	"contactId" text NOT NULL,
	"field" text NOT NULL,
	"value" text NOT NULL,
	"score" double precision NOT NULL,
	"band" "FactBand" NOT NULL,
	"evidence" jsonb NOT NULL,
	"method" text NOT NULL,
	"sourceUrl" text,
	"sessionId" text,
	"status" "FactStatus" DEFAULT 'PROPOSED' NOT NULL,
	"decidedById" text,
	"decidedAt" timestamp (3),
	"observedAt" timestamp (3) DEFAULT CURRENT_TIMESTAMP NOT NULL,
	"supersededAt" timestamp (3)
);
--> statement-breakpoint
CREATE TABLE "deal" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"companyId" text NOT NULL,
	"ownerId" text NOT NULL,
	"stage" "DealStage" DEFAULT 'DEMO_BOOKED' NOT NULL,
	"stageChangedAt" timestamp (3) DEFAULT CURRENT_TIMESTAMP NOT NULL,
	"amount" numeric(14, 2),
	"currency" text DEFAULT 'USD' NOT NULL,
	"expectedCloseDate" timestamp (3),
	"closedAt" timestamp (3),
	"closedReason" text,
	"baseAmount" numeric(24, 4),
	"baseCurrency" text,
	"fxRate" numeric(20, 10),
	"fxRateAt" timestamp (3),
	"lastActivityAt" timestamp (3),
	"archivedAt" timestamp (3),
	"createdAt" timestamp (3) DEFAULT CURRENT_TIMESTAMP NOT NULL,
	"updatedAt" timestamp (3) NOT NULL
);
--> statement-breakpoint
CREATE TABLE "dealContact" (
	"dealId" text NOT NULL,
	"contactId" text NOT NULL,
	"role" text,
	CONSTRAINT "dealContact_pkey" PRIMARY KEY("dealId","contactId")
);
--> statement-breakpoint
CREATE TABLE "emailMessage" (
	"id" text PRIMARY KEY NOT NULL,
	"threadId" text NOT NULL,
	"rfcMessageId" text NOT NULL,
	"syncedByUserId" text,
	"gmailMessageId" text,
	"outlookMessageId" text,
	"outlookWebLink" text,
	"direction" "EmailDirection" NOT NULL,
	"fromEmail" text NOT NULL,
	"fromName" text,
	"recipients" jsonb NOT NULL,
	"subject" text,
	"snippet" text,
	"body" text,
	"sentAt" timestamp (3) NOT NULL,
	"createdAt" timestamp (3) DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE TABLE "emailThread" (
	"id" text PRIMARY KEY NOT NULL,
	"rootMessageId" text NOT NULL,
	"subject" text,
	"companyId" text,
	"contactId" text,
	"firstMessageAt" timestamp (3) NOT NULL,
	"lastMessageAt" timestamp (3) NOT NULL,
	"messageCount" integer DEFAULT 0 NOT NULL,
	"createdAt" timestamp (3) DEFAULT CURRENT_TIMESTAMP NOT NULL,
	"updatedAt" timestamp (3) NOT NULL
);
--> statement-breakpoint
CREATE TABLE "exchangeRate" (
	"id" text PRIMARY KEY NOT NULL,
	"baseCurrency" text NOT NULL,
	"quoteCurrency" text NOT NULL,
	"rate" numeric(20, 10) NOT NULL,
	"asOf" timestamp (3) NOT NULL,
	"source" "RateSource" NOT NULL,
	"provider" text,
	"createdAt" timestamp (3) DEFAULT CURRENT_TIMESTAMP NOT NULL,
	"updatedAt" timestamp (3) NOT NULL
);
--> statement-breakpoint
CREATE TABLE "fieldDefinition" (
	"id" text PRIMARY KEY NOT NULL,
	"entity" "FieldEntity" NOT NULL,
	"key" text NOT NULL,
	"label" text NOT NULL,
	"type" "FieldType" NOT NULL,
	"agentFilled" boolean DEFAULT true NOT NULL,
	"agentBrief" text,
	"required" boolean DEFAULT false NOT NULL,
	"showOnSheet" boolean DEFAULT true NOT NULL,
	"showOnTable" boolean DEFAULT false NOT NULL,
	"showOnFilter" boolean DEFAULT false NOT NULL,
	"position" integer NOT NULL,
	"archivedAt" timestamp (3),
	"createdAt" timestamp (3) DEFAULT CURRENT_TIMESTAMP NOT NULL,
	"updatedAt" timestamp (3) NOT NULL
);
--> statement-breakpoint
CREATE TABLE "fieldOption" (
	"id" text PRIMARY KEY NOT NULL,
	"fieldId" text NOT NULL,
	"label" text NOT NULL,
	"position" integer NOT NULL,
	"archivedAt" timestamp (3)
);
--> statement-breakpoint
CREATE TABLE "fieldValue" (
	"id" text PRIMARY KEY NOT NULL,
	"fieldId" text NOT NULL,
	"companyId" text,
	"contactId" text,
	"dealId" text,
	"text" text,
	"number" numeric(24, 4),
	"date" timestamp (3),
	"bool" boolean,
	"optionId" text,
	"userId" text,
	"updatedAt" timestamp (3) NOT NULL
);
--> statement-breakpoint
CREATE TABLE "formSubmission" (
	"id" text PRIMARY KEY NOT NULL,
	"visitorId" text,
	"contactId" text,
	"host" text NOT NULL,
	"path" text NOT NULL,
	"email" text,
	"fields" jsonb NOT NULL,
	"firstTouch" jsonb,
	"lastTouch" jsonb,
	"dedupeKey" text NOT NULL,
	"filedAt" timestamp (3),
	"skipReason" text,
	"createdAt" timestamp (3) DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE TABLE "install" (
	"id" text PRIMARY KEY NOT NULL,
	"uuid" text NOT NULL,
	"version" text NOT NULL,
	"lastRollupAt" timestamp (3),
	"createdAt" timestamp (3) DEFAULT CURRENT_TIMESTAMP NOT NULL,
	"updatedAt" timestamp (3) NOT NULL
);
--> statement-breakpoint
CREATE TABLE "invitation" (
	"id" text PRIMARY KEY NOT NULL,
	"organizationId" text NOT NULL,
	"email" text NOT NULL,
	"role" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"expiresAt" timestamp (3) NOT NULL,
	"createdAt" timestamp (3) DEFAULT CURRENT_TIMESTAMP NOT NULL,
	"inviterId" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "mailboxSync" (
	"id" text PRIMARY KEY NOT NULL,
	"userId" text NOT NULL,
	"source" text NOT NULL,
	"status" "GoogleSyncStatus" DEFAULT 'IDLE' NOT NULL,
	"cursor" text,
	"lastSyncedAt" timestamp (3),
	"lastError" text,
	"retryAfter" timestamp (3),
	"autoCreate" boolean DEFAULT false NOT NULL,
	"createdAt" timestamp (3) DEFAULT CURRENT_TIMESTAMP NOT NULL,
	"updatedAt" timestamp (3) NOT NULL
);
--> statement-breakpoint
CREATE TABLE "mcpClientRegistration" (
	"id" text PRIMARY KEY NOT NULL,
	"platformSlug" text NOT NULL,
	"metadataFingerprint" text NOT NULL,
	"issuer" text NOT NULL,
	"clientId" text NOT NULL,
	"encryptedClientSecret" text,
	"encryptedRegistrationAccessToken" text,
	"clientIdIssuedAt" timestamp (3),
	"clientSecretExpiresAt" timestamp (3),
	"createdAt" timestamp (3) DEFAULT CURRENT_TIMESTAMP NOT NULL,
	"updatedAt" timestamp (3) NOT NULL
);
--> statement-breakpoint
CREATE TABLE "mcpConnection" (
	"id" text PRIMARY KEY NOT NULL,
	"organizationId" text NOT NULL,
	"platformSlug" text NOT NULL,
	"status" "McpConnectionStatus" DEFAULT 'CONNECTING' NOT NULL,
	"accessMode" "McpAccessMode" NOT NULL,
	"grantedScopes" text[],
	"encryptedAccessToken" text,
	"encryptedRefreshToken" text,
	"tokenExpiresAt" timestamp (3),
	"registrationId" text NOT NULL,
	"connectedById" text NOT NULL,
	"connectedAt" timestamp (3),
	"lastSuccessfulCallAt" timestamp (3),
	"lastErrorCode" text,
	"createdAt" timestamp (3) DEFAULT CURRENT_TIMESTAMP NOT NULL,
	"updatedAt" timestamp (3) NOT NULL
);
--> statement-breakpoint
CREATE TABLE "mcpOauthState" (
	"id" text PRIMARY KEY NOT NULL,
	"stateHash" text NOT NULL,
	"organizationId" text NOT NULL,
	"userId" text NOT NULL,
	"platformSlug" text NOT NULL,
	"accessMode" "McpAccessMode" NOT NULL,
	"returnPath" text NOT NULL,
	"encryptedCodeVerifier" text NOT NULL,
	"registrationId" text NOT NULL,
	"expiresAt" timestamp (3) NOT NULL,
	"consumedAt" timestamp (3),
	"createdAt" timestamp (3) DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE TABLE "mcpToolSnapshot" (
	"id" text PRIMARY KEY NOT NULL,
	"connectionId" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"inputSchema" jsonb NOT NULL,
	"annotations" jsonb,
	"fingerprint" text NOT NULL,
	"callKind" text NOT NULL,
	"reviewState" "McpToolReviewState" DEFAULT 'PENDING' NOT NULL,
	"lastSeenAt" timestamp (3) DEFAULT CURRENT_TIMESTAMP NOT NULL,
	"createdAt" timestamp (3) DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE TABLE "member" (
	"id" text PRIMARY KEY NOT NULL,
	"organizationId" text NOT NULL,
	"userId" text NOT NULL,
	"role" text DEFAULT 'member' NOT NULL,
	"createdAt" timestamp (3) NOT NULL
);
--> statement-breakpoint
CREATE TABLE "organization" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"logo" text,
	"createdAt" timestamp (3) NOT NULL,
	"metadata" text,
	"website" text
);
--> statement-breakpoint
CREATE TABLE "rateLimit" (
	"id" text PRIMARY KEY NOT NULL,
	"key" text NOT NULL,
	"count" integer NOT NULL,
	"lastRequest" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "savedView" (
	"id" text PRIMARY KEY NOT NULL,
	"entity" "FieldEntity" NOT NULL,
	"name" text NOT NULL,
	"shared" boolean DEFAULT false NOT NULL,
	"filters" jsonb NOT NULL,
	"ownerId" text NOT NULL,
	"createdAt" timestamp (3) DEFAULT CURRENT_TIMESTAMP NOT NULL,
	"updatedAt" timestamp (3) NOT NULL
);
--> statement-breakpoint
CREATE TABLE "session" (
	"id" text PRIMARY KEY NOT NULL,
	"expiresAt" timestamp (3) NOT NULL,
	"token" text NOT NULL,
	"createdAt" timestamp (3) DEFAULT CURRENT_TIMESTAMP NOT NULL,
	"updatedAt" timestamp (3) NOT NULL,
	"ipAddress" text,
	"userAgent" text,
	"userId" text NOT NULL,
	"activeOrganizationId" text
);
--> statement-breakpoint
CREATE TABLE "slackChannel" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"memberCount" integer,
	"available" boolean DEFAULT true NOT NULL,
	"isPrivate" boolean DEFAULT false NOT NULL,
	"isMember" boolean DEFAULT false NOT NULL,
	"inviteRequestedAt" timestamp (3),
	"classifiedAt" timestamp (3),
	"createdAt" timestamp (3) DEFAULT CURRENT_TIMESTAMP NOT NULL,
	"updatedAt" timestamp (3) NOT NULL
);
--> statement-breakpoint
CREATE TABLE "slackInstallation" (
	"installerId" text PRIMARY KEY NOT NULL,
	"teamId" text NOT NULL,
	"teamName" text,
	"userToken" text,
	"userScopes" text NOT NULL,
	"createdAt" timestamp (3) DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE TABLE "slackMemberMatch" (
	"id" text PRIMARY KEY NOT NULL,
	"crmUserId" text NOT NULL,
	"slackUserId" text,
	"slackHandle" text,
	"slackEmail" text,
	"createdAt" timestamp (3) DEFAULT CURRENT_TIMESTAMP NOT NULL,
	"updatedAt" timestamp (3) NOT NULL
);
--> statement-breakpoint
CREATE TABLE "slackWorkspaceGrant" (
	"id" text PRIMARY KEY NOT NULL,
	"teamId" text NOT NULL,
	"teamName" text,
	"userToken" text NOT NULL,
	"userScopes" text NOT NULL,
	"createdAt" timestamp (3) DEFAULT CURRENT_TIMESTAMP NOT NULL,
	"updatedAt" timestamp (3) NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ssoProvider" (
	"id" text PRIMARY KEY NOT NULL,
	"issuer" text NOT NULL,
	"oidcConfig" text,
	"samlConfig" text,
	"userId" text,
	"providerId" text NOT NULL,
	"organizationId" text,
	"domain" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "suppressedContact" (
	"email" text PRIMARY KEY NOT NULL,
	"reason" text,
	"createdAt" timestamp (3) DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE TABLE "suppressedDomain" (
	"domain" text PRIMARY KEY NOT NULL,
	"reason" text,
	"createdAt" timestamp (3) DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE TABLE "telemetryCounter" (
	"name" text PRIMARY KEY NOT NULL,
	"count" integer DEFAULT 0 NOT NULL,
	"updatedAt" timestamp (3) NOT NULL
);
--> statement-breakpoint
CREATE TABLE "telemetryMilestone" (
	"step" text PRIMARY KEY NOT NULL,
	"reachedAt" timestamp (3) DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE TABLE "trackedDomain" (
	"id" text PRIMARY KEY NOT NULL,
	"host" text NOT NULL,
	"scope" "DomainScope" DEFAULT 'EXACT_HOST' NOT NULL,
	"pageViews" integer DEFAULT 0 NOT NULL,
	"lastSeenAt" timestamp (3),
	"createdAt" timestamp (3) DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE TABLE "trackedEvent" (
	"id" text PRIMARY KEY NOT NULL,
	"visitorId" text NOT NULL,
	"type" text NOT NULL,
	"host" text NOT NULL,
	"path" text NOT NULL,
	"referrer" text,
	"label" text,
	"source" text,
	"medium" text,
	"campaign" text,
	"occurredAt" timestamp (3) NOT NULL
);
--> statement-breakpoint
CREATE TABLE "trackedPageDaily" (
	"day" timestamp (3) NOT NULL,
	"host" text NOT NULL,
	"path" text NOT NULL,
	"views" integer DEFAULT 0 NOT NULL,
	"visitors" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "trackedPageDaily_pkey" PRIMARY KEY("day","host","path")
);
--> statement-breakpoint
CREATE TABLE "trackedVisitor" (
	"id" text PRIMARY KEY NOT NULL,
	"contactId" text,
	"firstSource" text,
	"firstMedium" text,
	"firstCampaign" text,
	"firstTerm" text,
	"firstContent" text,
	"firstReferrer" text,
	"firstLanding" text,
	"firstTouchAt" timestamp (3),
	"lastSource" text,
	"lastMedium" text,
	"lastCampaign" text,
	"lastTerm" text,
	"lastContent" text,
	"lastReferrer" text,
	"lastLanding" text,
	"lastTouchAt" timestamp (3),
	"firstSeen" timestamp (3) DEFAULT CURRENT_TIMESTAMP NOT NULL,
	"lastSeen" timestamp (3) NOT NULL
);
--> statement-breakpoint
CREATE TABLE "trackingCounter" (
	"key" text PRIMARY KEY NOT NULL,
	"value" integer DEFAULT 0 NOT NULL,
	"expiresAt" timestamp (3) NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"email" text NOT NULL,
	"emailVerified" boolean DEFAULT false NOT NULL,
	"image" text,
	"createdAt" timestamp (3) DEFAULT CURRENT_TIMESTAMP NOT NULL,
	"updatedAt" timestamp (3) NOT NULL
);
--> statement-breakpoint
CREATE TABLE "verification" (
	"id" text PRIMARY KEY NOT NULL,
	"identifier" text NOT NULL,
	"value" text NOT NULL,
	"expiresAt" timestamp (3) NOT NULL,
	"createdAt" timestamp (3) DEFAULT CURRENT_TIMESTAMP NOT NULL,
	"updatedAt" timestamp (3) NOT NULL
);
--> statement-breakpoint
CREATE TABLE "workspaceProfile" (
	"id" text PRIMARY KEY NOT NULL,
	"website" text NOT NULL,
	"narrative" text NOT NULL,
	"sections" jsonb NOT NULL,
	"sourceUrl" text,
	"sessionId" text,
	"refreshedAt" timestamp (3) DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE INDEX "account_userId_idx" ON "account" USING btree ("userId");
--> statement-breakpoint
CREATE UNIQUE INDEX "activity_emailThreadId_key" ON "activity" USING btree ("emailThreadId");
--> statement-breakpoint
CREATE UNIQUE INDEX "activity_calendarEventId_key" ON "activity" USING btree ("calendarEventId");
--> statement-breakpoint
CREATE INDEX "activity_companyId_createdAt_idx" ON "activity" USING btree ("companyId","createdAt");
--> statement-breakpoint
CREATE INDEX "activity_dealId_createdAt_idx" ON "activity" USING btree ("dealId","createdAt");
--> statement-breakpoint
CREATE INDEX "activity_contactId_createdAt_idx" ON "activity" USING btree ("contactId","createdAt");
--> statement-breakpoint
CREATE INDEX "activity_dueAt_idx" ON "activity" USING btree ("dueAt");
--> statement-breakpoint
CREATE INDEX "activity_createdById_idx" ON "activity" USING btree ("createdById");
--> statement-breakpoint
CREATE UNIQUE INDEX "agentAction_idempotencyKey_key" ON "agentAction" USING btree ("idempotencyKey");
--> statement-breakpoint
CREATE INDEX "agentAction_agentId_plannedAt_idx" ON "agentAction" USING btree ("agentId","plannedAt");
--> statement-breakpoint
CREATE INDEX "agentAction_runId_plannedAt_idx" ON "agentAction" USING btree ("runId","plannedAt");
--> statement-breakpoint
CREATE INDEX "agentAction_provider_externalId_idx" ON "agentAction" USING btree ("provider","externalId");
--> statement-breakpoint
CREATE INDEX "agentAction_status_plannedAt_idx" ON "agentAction" USING btree ("status","plannedAt");
--> statement-breakpoint
CREATE UNIQUE INDEX "agentAuditEvent_agentId_type_requestId_key" ON "agentAuditEvent" USING btree ("agentId","type","requestId");
--> statement-breakpoint
CREATE INDEX "agentAuditEvent_agentId_emittedAt_idx" ON "agentAuditEvent" USING btree ("agentId","emittedAt");
--> statement-breakpoint
CREATE INDEX "agentAuditEvent_versionId_emittedAt_idx" ON "agentAuditEvent" USING btree ("versionId","emittedAt");
--> statement-breakpoint
CREATE INDEX "agentAuditEvent_actorUserId_emittedAt_idx" ON "agentAuditEvent" USING btree ("actorUserId","emittedAt");
--> statement-breakpoint
CREATE INDEX "agentAuditEvent_type_emittedAt_idx" ON "agentAuditEvent" USING btree ("type","emittedAt");
--> statement-breakpoint
CREATE UNIQUE INDEX "agentBuilderArtifact_conversation_path_revision_key" ON "agentBuilderArtifact" USING btree ("conversationId","path","revision") WHERE "conversationId" IS NOT NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX "agentBuilderArtifact_version_path_revision_key" ON "agentBuilderArtifact" USING btree ("versionId","path","revision") WHERE "versionId" IS NOT NULL;
--> statement-breakpoint
CREATE INDEX "agentBuilderArtifact_conversationId_createdAt_idx" ON "agentBuilderArtifact" USING btree ("conversationId","createdAt");
--> statement-breakpoint
CREATE INDEX "agentBuilderArtifact_versionId_path_idx" ON "agentBuilderArtifact" USING btree ("versionId","path");
--> statement-breakpoint
CREATE UNIQUE INDEX "agentConversation_sessionId_key" ON "agentConversation" USING btree ("sessionId");
--> statement-breakpoint
CREATE INDEX "agentConversation_contactId_lastMessageAt_idx" ON "agentConversation" USING btree ("contactId","lastMessageAt");
--> statement-breakpoint
CREATE INDEX "agentConversation_companyId_lastMessageAt_idx" ON "agentConversation" USING btree ("companyId","lastMessageAt");
--> statement-breakpoint
CREATE INDEX "agentConversation_dealId_lastMessageAt_idx" ON "agentConversation" USING btree ("dealId","lastMessageAt");
--> statement-breakpoint
CREATE INDEX "agentConversation_userId_kind_lastMessageAt_idx" ON "agentConversation" USING btree ("userId","kind","lastMessageAt");
--> statement-breakpoint
CREATE INDEX "agentConversation_agentId_lastMessageAt_idx" ON "agentConversation" USING btree ("agentId","lastMessageAt");
--> statement-breakpoint
CREATE INDEX "agentConversationAttachment_submissionId_position_idx" ON "agentConversationAttachment" USING btree ("submissionId","position");
--> statement-breakpoint
CREATE UNIQUE INDEX "agentConversationFeedback_conversationId_userId_messageId_key" ON "agentConversationFeedback" USING btree ("conversationId","userId","messageId");
--> statement-breakpoint
CREATE INDEX "agentConversationFeedback_conversationId_createdAt_idx" ON "agentConversationFeedback" USING btree ("conversationId","createdAt");
--> statement-breakpoint
CREATE UNIQUE INDEX "agentConversationShare_tokenHash_key" ON "agentConversationShare" USING btree ("tokenHash");
--> statement-breakpoint
CREATE UNIQUE INDEX "agentConversationShare_one_active_per_conversation" ON "agentConversationShare" USING btree ("conversationId") WHERE "revokedAt" IS NULL;
--> statement-breakpoint
CREATE INDEX "agentConversationShare_conversationId_revokedAt_idx" ON "agentConversationShare" USING btree ("conversationId","revokedAt");
--> statement-breakpoint
CREATE UNIQUE INDEX "agentConversationSubmission_clientRequestId_key" ON "agentConversationSubmission" USING btree ("clientRequestId");
--> statement-breakpoint
CREATE UNIQUE INDEX "agentConversationSubmission_conversationId_inputRequestId_key" ON "agentConversationSubmission" USING btree ("conversationId","inputRequestId");
--> statement-breakpoint
CREATE INDEX "agentConversationSubmission_conversationId_createdAt_idx" ON "agentConversationSubmission" USING btree ("conversationId","createdAt");
--> statement-breakpoint
CREATE INDEX "agentConversationSubmission_status_createdAt_idx" ON "agentConversationSubmission" USING btree ("status","createdAt");
--> statement-breakpoint
CREATE UNIQUE INDEX "agentDefinition_currentVersionId_key" ON "agentDefinition" USING btree ("currentVersionId");
--> statement-breakpoint
CREATE UNIQUE INDEX "agentDefinition_currentVersionId_id_key" ON "agentDefinition" USING btree ("currentVersionId","id");
--> statement-breakpoint
CREATE INDEX "agentDefinition_status_updatedAt_idx" ON "agentDefinition" USING btree ("status","updatedAt");
--> statement-breakpoint
CREATE INDEX "agentDefinition_createdById_createdAt_idx" ON "agentDefinition" USING btree ("createdById","createdAt");
--> statement-breakpoint
CREATE INDEX "agentEvent_sessionId_emittedAt_idx" ON "agentEvent" USING btree ("sessionId","emittedAt");
--> statement-breakpoint
CREATE UNIQUE INDEX "agentEvent_sessionId_streamIndex_key" ON "agentEvent" USING btree ("sessionId","streamIndex");
--> statement-breakpoint
CREATE INDEX "agentEvent_contactId_emittedAt_idx" ON "agentEvent" USING btree ("contactId","emittedAt");
--> statement-breakpoint
CREATE INDEX "agentEvent_conversationId_emittedAt_idx" ON "agentEvent" USING btree ("conversationId","emittedAt");
--> statement-breakpoint
CREATE UNIQUE INDEX "agentRun_sessionId_key" ON "agentRun" USING btree ("sessionId");
--> statement-breakpoint
CREATE UNIQUE INDEX "agentRun_idempotencyKey_key" ON "agentRun" USING btree ("idempotencyKey");
--> statement-breakpoint
CREATE UNIQUE INDEX "agentRun_correlationId_key" ON "agentRun" USING btree ("correlationId");
--> statement-breakpoint
CREATE UNIQUE INDEX "agentRun_id_agentId_key" ON "agentRun" USING btree ("id","agentId");
--> statement-breakpoint
CREATE INDEX "agentRun_agentId_createdAt_idx" ON "agentRun" USING btree ("agentId","createdAt");
--> statement-breakpoint
CREATE INDEX "agentRun_versionId_createdAt_idx" ON "agentRun" USING btree ("versionId","createdAt");
--> statement-breakpoint
CREATE INDEX "agentRun_status_createdAt_idx" ON "agentRun" USING btree ("status","createdAt");
--> statement-breakpoint
CREATE INDEX "agentRun_triggerId_createdAt_idx" ON "agentRun" USING btree ("triggerId","createdAt");
--> statement-breakpoint
CREATE UNIQUE INDEX "agentRunEvent_runId_sequence_key" ON "agentRunEvent" USING btree ("runId","sequence");
--> statement-breakpoint
CREATE INDEX "agentRunEvent_runId_emittedAt_idx" ON "agentRunEvent" USING btree ("runId","emittedAt");
--> statement-breakpoint
CREATE INDEX "agentTask_dueAt_leasedUntil_idx" ON "agentTask" USING btree ("dueAt","leasedUntil");
--> statement-breakpoint
CREATE INDEX "agentTask_contactId_idx" ON "agentTask" USING btree ("contactId");
--> statement-breakpoint
CREATE INDEX "agentTask_dealId_idx" ON "agentTask" USING btree ("dealId");
--> statement-breakpoint
CREATE INDEX "agentTask_kind_subject_idx" ON "agentTask" USING btree ("kind","subject") WHERE "finishedAt" IS NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX "agentTrigger_id_agentId_key" ON "agentTrigger" USING btree ("id","agentId");
--> statement-breakpoint
CREATE INDEX "agentTrigger_agentId_enabled_idx" ON "agentTrigger" USING btree ("agentId","enabled");
--> statement-breakpoint
CREATE INDEX "agentTrigger_enabled_nextRunAt_idx" ON "agentTrigger" USING btree ("enabled","nextRunAt");
--> statement-breakpoint
CREATE INDEX "agentTrigger_versionId_idx" ON "agentTrigger" USING btree ("versionId");
--> statement-breakpoint
CREATE UNIQUE INDEX "agentVersion_agentId_number_key" ON "agentVersion" USING btree ("agentId","number");
--> statement-breakpoint
CREATE UNIQUE INDEX "agentVersion_id_agentId_key" ON "agentVersion" USING btree ("id","agentId");
--> statement-breakpoint
CREATE INDEX "agentVersion_agentId_createdAt_idx" ON "agentVersion" USING btree ("agentId","createdAt");
--> statement-breakpoint
CREATE INDEX "agentVersion_status_createdAt_idx" ON "agentVersion" USING btree ("status","createdAt");
--> statement-breakpoint
CREATE INDEX "apikey_referenceId_idx" ON "apikey" USING btree ("referenceId");
--> statement-breakpoint
CREATE INDEX "apikey_configId_idx" ON "apikey" USING btree ("configId");
--> statement-breakpoint
CREATE INDEX "apikey_key_idx" ON "apikey" USING btree ("key");
--> statement-breakpoint
CREATE UNIQUE INDEX "appSetting_trackingSiteId_key" ON "appSetting" USING btree ("trackingSiteId");
--> statement-breakpoint
CREATE UNIQUE INDEX "calendarAttendee_eventId_email_key" ON "calendarAttendee" USING btree ("eventId","email");
--> statement-breakpoint
CREATE INDEX "calendarAttendee_contactId_idx" ON "calendarAttendee" USING btree ("contactId");
--> statement-breakpoint
CREATE UNIQUE INDEX "calendarEvent_iCalUid_originalStartTime_key" ON "calendarEvent" USING btree ("iCalUid","originalStartTime");
--> statement-breakpoint
CREATE INDEX "calendarEvent_companyId_startsAt_idx" ON "calendarEvent" USING btree ("companyId","startsAt");
--> statement-breakpoint
CREATE INDEX "calendarEvent_contactId_startsAt_idx" ON "calendarEvent" USING btree ("contactId","startsAt");
--> statement-breakpoint
CREATE UNIQUE INDEX "company_primaryContactId_key" ON "company" USING btree ("primaryContactId");
--> statement-breakpoint
CREATE UNIQUE INDEX "company_domain_active_key" ON "company" USING btree ("domain") WHERE "archivedAt" IS NULL;
--> statement-breakpoint
CREATE INDEX "company_ownerId_idx" ON "company" USING btree ("ownerId");
--> statement-breakpoint
CREATE INDEX "company_name_idx" ON "company" USING btree ("name");
--> statement-breakpoint
CREATE INDEX "company_lastActivityAt_idx" ON "company" USING btree ("lastActivityAt");
--> statement-breakpoint
CREATE INDEX "company_archivedAt_idx" ON "company" USING btree ("archivedAt");
--> statement-breakpoint
CREATE UNIQUE INDEX "contact_email_active_key" ON "contact" USING btree ("email") WHERE "archivedAt" IS NULL;
--> statement-breakpoint
CREATE INDEX "contact_companyId_idx" ON "contact" USING btree ("companyId");
--> statement-breakpoint
CREATE INDEX "contact_ownerId_idx" ON "contact" USING btree ("ownerId");
--> statement-breakpoint
CREATE INDEX "contact_lastActivityAt_idx" ON "contact" USING btree ("lastActivityAt");
--> statement-breakpoint
CREATE INDEX "contact_archivedAt_idx" ON "contact" USING btree ("archivedAt");
--> statement-breakpoint
CREATE INDEX "contactFact_contactId_field_status_idx" ON "contactFact" USING btree ("contactId","field","status");
--> statement-breakpoint
CREATE INDEX "contactFact_status_observedAt_idx" ON "contactFact" USING btree ("status","observedAt");
--> statement-breakpoint
CREATE INDEX "deal_companyId_idx" ON "deal" USING btree ("companyId");
--> statement-breakpoint
CREATE INDEX "deal_ownerId_idx" ON "deal" USING btree ("ownerId");
--> statement-breakpoint
CREATE INDEX "deal_stage_idx" ON "deal" USING btree ("stage");
--> statement-breakpoint
CREATE INDEX "deal_expectedCloseDate_idx" ON "deal" USING btree ("expectedCloseDate");
--> statement-breakpoint
CREATE INDEX "deal_lastActivityAt_idx" ON "deal" USING btree ("lastActivityAt");
--> statement-breakpoint
CREATE INDEX "deal_baseAmount_idx" ON "deal" USING btree ("baseAmount");
--> statement-breakpoint
CREATE INDEX "deal_currency_idx" ON "deal" USING btree ("currency");
--> statement-breakpoint
CREATE INDEX "deal_archivedAt_idx" ON "deal" USING btree ("archivedAt");
--> statement-breakpoint
CREATE INDEX "dealContact_contactId_idx" ON "dealContact" USING btree ("contactId");
--> statement-breakpoint
CREATE UNIQUE INDEX "emailMessage_rfcMessageId_key" ON "emailMessage" USING btree ("rfcMessageId");
--> statement-breakpoint
CREATE INDEX "emailMessage_threadId_sentAt_idx" ON "emailMessage" USING btree ("threadId","sentAt");
--> statement-breakpoint
CREATE UNIQUE INDEX "emailThread_rootMessageId_key" ON "emailThread" USING btree ("rootMessageId");
--> statement-breakpoint
CREATE INDEX "emailThread_companyId_lastMessageAt_idx" ON "emailThread" USING btree ("companyId","lastMessageAt");
--> statement-breakpoint
CREATE INDEX "emailThread_contactId_lastMessageAt_idx" ON "emailThread" USING btree ("contactId","lastMessageAt");
--> statement-breakpoint
CREATE UNIQUE INDEX "exchangeRate_baseCurrency_quoteCurrency_source_key" ON "exchangeRate" USING btree ("baseCurrency","quoteCurrency","source");
--> statement-breakpoint
CREATE INDEX "exchangeRate_baseCurrency_quoteCurrency_idx" ON "exchangeRate" USING btree ("baseCurrency","quoteCurrency");
--> statement-breakpoint
CREATE UNIQUE INDEX "fieldDefinition_entity_key_key" ON "fieldDefinition" USING btree ("entity","key");
--> statement-breakpoint
CREATE INDEX "fieldDefinition_entity_position_idx" ON "fieldDefinition" USING btree ("entity","position");
--> statement-breakpoint
CREATE INDEX "fieldOption_fieldId_position_idx" ON "fieldOption" USING btree ("fieldId","position");
--> statement-breakpoint
CREATE UNIQUE INDEX "fieldValue_fieldId_companyId_key" ON "fieldValue" USING btree ("fieldId","companyId");
--> statement-breakpoint
CREATE UNIQUE INDEX "fieldValue_fieldId_contactId_key" ON "fieldValue" USING btree ("fieldId","contactId");
--> statement-breakpoint
CREATE UNIQUE INDEX "fieldValue_fieldId_dealId_key" ON "fieldValue" USING btree ("fieldId","dealId");
--> statement-breakpoint
CREATE INDEX "fieldValue_fieldId_text_idx" ON "fieldValue" USING btree ("fieldId","text");
--> statement-breakpoint
CREATE INDEX "fieldValue_fieldId_number_idx" ON "fieldValue" USING btree ("fieldId","number");
--> statement-breakpoint
CREATE INDEX "fieldValue_fieldId_date_idx" ON "fieldValue" USING btree ("fieldId","date");
--> statement-breakpoint
CREATE INDEX "fieldValue_companyId_idx" ON "fieldValue" USING btree ("companyId");
--> statement-breakpoint
CREATE INDEX "fieldValue_contactId_idx" ON "fieldValue" USING btree ("contactId");
--> statement-breakpoint
CREATE INDEX "fieldValue_dealId_idx" ON "fieldValue" USING btree ("dealId");
--> statement-breakpoint
CREATE INDEX "fieldValue_optionId_idx" ON "fieldValue" USING btree ("optionId");
--> statement-breakpoint
CREATE INDEX "fieldValue_userId_idx" ON "fieldValue" USING btree ("userId");
--> statement-breakpoint
CREATE UNIQUE INDEX "formSubmission_dedupeKey_key" ON "formSubmission" USING btree ("dedupeKey");
--> statement-breakpoint
CREATE INDEX "formSubmission_contactId_idx" ON "formSubmission" USING btree ("contactId");
--> statement-breakpoint
CREATE INDEX "formSubmission_createdAt_idx" ON "formSubmission" USING btree ("createdAt");
--> statement-breakpoint
CREATE UNIQUE INDEX "install_uuid_key" ON "install" USING btree ("uuid");
--> statement-breakpoint
CREATE INDEX "invitation_organizationId_idx" ON "invitation" USING btree ("organizationId");
--> statement-breakpoint
CREATE INDEX "invitation_email_idx" ON "invitation" USING btree ("email");
--> statement-breakpoint
CREATE UNIQUE INDEX "mailboxSync_userId_source_key" ON "mailboxSync" USING btree ("userId","source");
--> statement-breakpoint
CREATE INDEX "mailboxSync_status_idx" ON "mailboxSync" USING btree ("status");
--> statement-breakpoint
CREATE UNIQUE INDEX "mcpClientRegistration_platformSlug_metadataFingerprint_key" ON "mcpClientRegistration" USING btree ("platformSlug","metadataFingerprint");
--> statement-breakpoint
CREATE INDEX "mcpClientRegistration_clientSecretExpiresAt_idx" ON "mcpClientRegistration" USING btree ("clientSecretExpiresAt");
--> statement-breakpoint
CREATE UNIQUE INDEX "mcpConnection_organizationId_platformSlug_key" ON "mcpConnection" USING btree ("organizationId","platformSlug");
--> statement-breakpoint
CREATE INDEX "mcpConnection_status_updatedAt_idx" ON "mcpConnection" USING btree ("status","updatedAt");
--> statement-breakpoint
CREATE UNIQUE INDEX "mcpOauthState_stateHash_key" ON "mcpOauthState" USING btree ("stateHash");
--> statement-breakpoint
CREATE INDEX "mcpOauthState_expiresAt_consumedAt_idx" ON "mcpOauthState" USING btree ("expiresAt","consumedAt");
--> statement-breakpoint
CREATE UNIQUE INDEX "mcpToolSnapshot_connectionId_name_fingerprint_key" ON "mcpToolSnapshot" USING btree ("connectionId","name","fingerprint");
--> statement-breakpoint
CREATE INDEX "mcpToolSnapshot_connectionId_name_lastSeenAt_idx" ON "mcpToolSnapshot" USING btree ("connectionId","name","lastSeenAt");
--> statement-breakpoint
CREATE INDEX "mcpToolSnapshot_reviewState_lastSeenAt_idx" ON "mcpToolSnapshot" USING btree ("reviewState","lastSeenAt");
--> statement-breakpoint
CREATE UNIQUE INDEX "member_organizationId_userId_key" ON "member" USING btree ("organizationId","userId");
--> statement-breakpoint
CREATE INDEX "member_organizationId_idx" ON "member" USING btree ("organizationId");
--> statement-breakpoint
CREATE INDEX "member_userId_idx" ON "member" USING btree ("userId");
--> statement-breakpoint
CREATE UNIQUE INDEX "organization_slug_key" ON "organization" USING btree ("slug");
--> statement-breakpoint
CREATE UNIQUE INDEX "rateLimit_key_key" ON "rateLimit" USING btree ("key");
--> statement-breakpoint
CREATE UNIQUE INDEX "savedView_entity_ownerId_name_key" ON "savedView" USING btree ("entity","ownerId","name");
--> statement-breakpoint
CREATE INDEX "savedView_entity_shared_idx" ON "savedView" USING btree ("entity","shared");
--> statement-breakpoint
CREATE UNIQUE INDEX "session_token_key" ON "session" USING btree ("token");
--> statement-breakpoint
CREATE INDEX "session_userId_idx" ON "session" USING btree ("userId");
--> statement-breakpoint
CREATE INDEX "slackChannel_available_name_idx" ON "slackChannel" USING btree ("available","name");
--> statement-breakpoint
CREATE INDEX "slackChannel_updatedAt_idx" ON "slackChannel" USING btree ("updatedAt");
--> statement-breakpoint
CREATE UNIQUE INDEX "slackMemberMatch_crmUserId_key" ON "slackMemberMatch" USING btree ("crmUserId");
--> statement-breakpoint
CREATE INDEX "slackMemberMatch_slackUserId_idx" ON "slackMemberMatch" USING btree ("slackUserId");
--> statement-breakpoint
CREATE UNIQUE INDEX "slackWorkspaceGrant_teamId_key" ON "slackWorkspaceGrant" USING btree ("teamId");
--> statement-breakpoint
CREATE UNIQUE INDEX "ssoProvider_providerId_key" ON "ssoProvider" USING btree ("providerId");
--> statement-breakpoint
CREATE UNIQUE INDEX "trackedDomain_host_key" ON "trackedDomain" USING btree ("host");
--> statement-breakpoint
CREATE INDEX "trackedEvent_visitorId_occurredAt_idx" ON "trackedEvent" USING btree ("visitorId","occurredAt");
--> statement-breakpoint
CREATE INDEX "trackedEvent_occurredAt_idx" ON "trackedEvent" USING btree ("occurredAt");
--> statement-breakpoint
CREATE INDEX "trackedEvent_host_occurredAt_idx" ON "trackedEvent" USING btree ("host","occurredAt");
--> statement-breakpoint
CREATE INDEX "trackedEvent_source_occurredAt_idx" ON "trackedEvent" USING btree ("source","occurredAt");
--> statement-breakpoint
CREATE INDEX "trackedPageDaily_host_day_idx" ON "trackedPageDaily" USING btree ("host","day");
--> statement-breakpoint
CREATE INDEX "trackedVisitor_contactId_idx" ON "trackedVisitor" USING btree ("contactId");
--> statement-breakpoint
CREATE INDEX "trackedVisitor_firstSource_idx" ON "trackedVisitor" USING btree ("firstSource");
--> statement-breakpoint
CREATE INDEX "trackingCounter_expiresAt_idx" ON "trackingCounter" USING btree ("expiresAt");
--> statement-breakpoint
CREATE UNIQUE INDEX "user_email_key" ON "user" USING btree ("email");
--> statement-breakpoint
CREATE INDEX "verification_identifier_idx" ON "verification" USING btree ("identifier");
--> statement-breakpoint
ALTER TABLE "account" ADD CONSTRAINT "account_userId_fkey" FOREIGN KEY ("userId") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE cascade;
--> statement-breakpoint
ALTER TABLE "activity" ADD CONSTRAINT "activity_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "public"."company"("id") ON DELETE cascade ON UPDATE cascade;
--> statement-breakpoint
ALTER TABLE "activity" ADD CONSTRAINT "activity_contactId_fkey" FOREIGN KEY ("contactId") REFERENCES "public"."contact"("id") ON DELETE cascade ON UPDATE cascade;
--> statement-breakpoint
ALTER TABLE "activity" ADD CONSTRAINT "activity_dealId_fkey" FOREIGN KEY ("dealId") REFERENCES "public"."deal"("id") ON DELETE cascade ON UPDATE cascade;
--> statement-breakpoint
ALTER TABLE "activity" ADD CONSTRAINT "activity_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "public"."user"("id") ON DELETE restrict ON UPDATE cascade;
--> statement-breakpoint
ALTER TABLE "activity" ADD CONSTRAINT "activity_emailThreadId_fkey" FOREIGN KEY ("emailThreadId") REFERENCES "public"."emailThread"("id") ON DELETE cascade ON UPDATE cascade;
--> statement-breakpoint
ALTER TABLE "activity" ADD CONSTRAINT "activity_calendarEventId_fkey" FOREIGN KEY ("calendarEventId") REFERENCES "public"."calendarEvent"("id") ON DELETE cascade ON UPDATE cascade;
--> statement-breakpoint
ALTER TABLE "agentAction" ADD CONSTRAINT "agentAction_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "public"."agentDefinition"("id") ON DELETE restrict ON UPDATE cascade;
--> statement-breakpoint
ALTER TABLE "agentAction" ADD CONSTRAINT "agentAction_runId_agentId_fkey" FOREIGN KEY ("runId","agentId") REFERENCES "public"."agentRun"("id","agentId") ON DELETE restrict ON UPDATE cascade;
--> statement-breakpoint
ALTER TABLE "agentAuditEvent" ADD CONSTRAINT "agentAuditEvent_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "public"."agentDefinition"("id") ON DELETE restrict ON UPDATE cascade;
--> statement-breakpoint
ALTER TABLE "agentAuditEvent" ADD CONSTRAINT "agentAuditEvent_versionId_agentId_fkey" FOREIGN KEY ("versionId","agentId") REFERENCES "public"."agentVersion"("id","agentId") ON DELETE restrict ON UPDATE cascade;
--> statement-breakpoint
ALTER TABLE "agentAuditEvent" ADD CONSTRAINT "agentAuditEvent_actorUserId_fkey" FOREIGN KEY ("actorUserId") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE cascade;
--> statement-breakpoint
ALTER TABLE "agentBuilderArtifact" ADD CONSTRAINT "agentBuilderArtifact_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "public"."agentConversation"("id") ON DELETE set null ON UPDATE cascade;
--> statement-breakpoint
ALTER TABLE "agentBuilderArtifact" ADD CONSTRAINT "agentBuilderArtifact_versionId_fkey" FOREIGN KEY ("versionId") REFERENCES "public"."agentVersion"("id") ON DELETE set null ON UPDATE cascade;
--> statement-breakpoint
ALTER TABLE "agentConversation" ADD CONSTRAINT "agentConversation_contactId_fkey" FOREIGN KEY ("contactId") REFERENCES "public"."contact"("id") ON DELETE cascade ON UPDATE cascade;
--> statement-breakpoint
ALTER TABLE "agentConversation" ADD CONSTRAINT "agentConversation_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "public"."company"("id") ON DELETE cascade ON UPDATE cascade;
--> statement-breakpoint
ALTER TABLE "agentConversation" ADD CONSTRAINT "agentConversation_dealId_fkey" FOREIGN KEY ("dealId") REFERENCES "public"."deal"("id") ON DELETE cascade ON UPDATE cascade;
--> statement-breakpoint
ALTER TABLE "agentConversation" ADD CONSTRAINT "agentConversation_userId_fkey" FOREIGN KEY ("userId") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE cascade;
--> statement-breakpoint
ALTER TABLE "agentConversation" ADD CONSTRAINT "agentConversation_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "public"."agentDefinition"("id") ON DELETE set null ON UPDATE cascade;
--> statement-breakpoint
ALTER TABLE "agentConversationAttachment" ADD CONSTRAINT "agentConversationAttachment_submissionId_fkey" FOREIGN KEY ("submissionId") REFERENCES "public"."agentConversationSubmission"("id") ON DELETE cascade ON UPDATE cascade;
--> statement-breakpoint
ALTER TABLE "agentConversationFeedback" ADD CONSTRAINT "agentConversationFeedback_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "public"."agentConversation"("id") ON DELETE cascade ON UPDATE cascade;
--> statement-breakpoint
ALTER TABLE "agentConversationFeedback" ADD CONSTRAINT "agentConversationFeedback_userId_fkey" FOREIGN KEY ("userId") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE cascade;
--> statement-breakpoint
ALTER TABLE "agentConversationShare" ADD CONSTRAINT "agentConversationShare_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "public"."agentConversation"("id") ON DELETE cascade ON UPDATE cascade;
--> statement-breakpoint
ALTER TABLE "agentConversationShare" ADD CONSTRAINT "agentConversationShare_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE cascade;
--> statement-breakpoint
ALTER TABLE "agentConversationSubmission" ADD CONSTRAINT "agentConversationSubmission_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "public"."agentConversation"("id") ON DELETE cascade ON UPDATE cascade;
--> statement-breakpoint
ALTER TABLE "agentConversationSubmission" ADD CONSTRAINT "agentConversationSubmission_submittedById_fkey" FOREIGN KEY ("submittedById") REFERENCES "public"."user"("id") ON DELETE restrict ON UPDATE cascade;
--> statement-breakpoint
ALTER TABLE "agentDefinition" ADD CONSTRAINT "agentDefinition_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "public"."user"("id") ON DELETE restrict ON UPDATE cascade;
--> statement-breakpoint
ALTER TABLE "agentDefinition" ADD CONSTRAINT "agentDefinition_currentVersionId_id_fkey" FOREIGN KEY ("currentVersionId","id") REFERENCES "public"."agentVersion"("id","agentId") ON DELETE restrict ON UPDATE cascade;
--> statement-breakpoint
ALTER TABLE "agentEvent" ADD CONSTRAINT "agentEvent_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "public"."agentConversation"("id") ON DELETE cascade ON UPDATE cascade;
--> statement-breakpoint
ALTER TABLE "agentRun" ADD CONSTRAINT "agentRun_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "public"."agentDefinition"("id") ON DELETE restrict ON UPDATE cascade;
--> statement-breakpoint
ALTER TABLE "agentRun" ADD CONSTRAINT "agentRun_versionId_agentId_fkey" FOREIGN KEY ("versionId","agentId") REFERENCES "public"."agentVersion"("id","agentId") ON DELETE restrict ON UPDATE cascade;
--> statement-breakpoint
ALTER TABLE "agentRun" ADD CONSTRAINT "agentRun_triggerId_agentId_fkey" FOREIGN KEY ("triggerId","agentId") REFERENCES "public"."agentTrigger"("id","agentId") ON DELETE restrict ON UPDATE cascade;
--> statement-breakpoint
ALTER TABLE "agentRun" ADD CONSTRAINT "agentRun_initiatedById_fkey" FOREIGN KEY ("initiatedById") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE cascade;
--> statement-breakpoint
ALTER TABLE "agentRunEvent" ADD CONSTRAINT "agentRunEvent_runId_fkey" FOREIGN KEY ("runId") REFERENCES "public"."agentRun"("id") ON DELETE restrict ON UPDATE cascade;
--> statement-breakpoint
ALTER TABLE "agentTrigger" ADD CONSTRAINT "agentTrigger_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "public"."agentDefinition"("id") ON DELETE restrict ON UPDATE cascade;
--> statement-breakpoint
ALTER TABLE "agentTrigger" ADD CONSTRAINT "agentTrigger_versionId_agentId_fkey" FOREIGN KEY ("versionId","agentId") REFERENCES "public"."agentVersion"("id","agentId") ON DELETE restrict ON UPDATE cascade;
--> statement-breakpoint
ALTER TABLE "agentTrigger" ADD CONSTRAINT "agentTrigger_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "public"."user"("id") ON DELETE restrict ON UPDATE cascade;
--> statement-breakpoint
ALTER TABLE "agentVersion" ADD CONSTRAINT "agentVersion_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "public"."agentDefinition"("id") ON DELETE restrict ON UPDATE cascade;
--> statement-breakpoint
ALTER TABLE "agentVersion" ADD CONSTRAINT "agentVersion_sourceConversationId_fkey" FOREIGN KEY ("sourceConversationId") REFERENCES "public"."agentConversation"("id") ON DELETE set null ON UPDATE cascade;
--> statement-breakpoint
ALTER TABLE "agentVersion" ADD CONSTRAINT "agentVersion_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "public"."user"("id") ON DELETE restrict ON UPDATE cascade;
--> statement-breakpoint
ALTER TABLE "apikey" ADD CONSTRAINT "apikey_referenceId_fkey" FOREIGN KEY ("referenceId") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE cascade;
--> statement-breakpoint
ALTER TABLE "calendarAttendee" ADD CONSTRAINT "calendarAttendee_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "public"."calendarEvent"("id") ON DELETE cascade ON UPDATE cascade;
--> statement-breakpoint
ALTER TABLE "calendarAttendee" ADD CONSTRAINT "calendarAttendee_contactId_fkey" FOREIGN KEY ("contactId") REFERENCES "public"."contact"("id") ON DELETE set null ON UPDATE cascade;
--> statement-breakpoint
ALTER TABLE "calendarEvent" ADD CONSTRAINT "calendarEvent_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "public"."company"("id") ON DELETE set null ON UPDATE cascade;
--> statement-breakpoint
ALTER TABLE "calendarEvent" ADD CONSTRAINT "calendarEvent_contactId_fkey" FOREIGN KEY ("contactId") REFERENCES "public"."contact"("id") ON DELETE set null ON UPDATE cascade;
--> statement-breakpoint
ALTER TABLE "company" ADD CONSTRAINT "company_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE cascade;
--> statement-breakpoint
ALTER TABLE "company" ADD CONSTRAINT "company_primaryContactId_fkey" FOREIGN KEY ("primaryContactId") REFERENCES "public"."contact"("id") ON DELETE set null ON UPDATE cascade;
--> statement-breakpoint
ALTER TABLE "companyEnrichment" ADD CONSTRAINT "companyEnrichment_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "public"."company"("id") ON DELETE cascade ON UPDATE cascade;
--> statement-breakpoint
ALTER TABLE "contact" ADD CONSTRAINT "contact_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "public"."company"("id") ON DELETE set null ON UPDATE cascade;
--> statement-breakpoint
ALTER TABLE "contact" ADD CONSTRAINT "contact_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE cascade;
--> statement-breakpoint
ALTER TABLE "contactBrief" ADD CONSTRAINT "contactBrief_contactId_fkey" FOREIGN KEY ("contactId") REFERENCES "public"."contact"("id") ON DELETE cascade ON UPDATE cascade;
--> statement-breakpoint
ALTER TABLE "contactFact" ADD CONSTRAINT "contactFact_contactId_fkey" FOREIGN KEY ("contactId") REFERENCES "public"."contact"("id") ON DELETE cascade ON UPDATE cascade;
--> statement-breakpoint
ALTER TABLE "contactFact" ADD CONSTRAINT "contactFact_decidedById_fkey" FOREIGN KEY ("decidedById") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE cascade;
--> statement-breakpoint
ALTER TABLE "deal" ADD CONSTRAINT "deal_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "public"."company"("id") ON DELETE cascade ON UPDATE cascade;
--> statement-breakpoint
ALTER TABLE "deal" ADD CONSTRAINT "deal_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "public"."user"("id") ON DELETE restrict ON UPDATE cascade;
--> statement-breakpoint
ALTER TABLE "dealContact" ADD CONSTRAINT "dealContact_dealId_fkey" FOREIGN KEY ("dealId") REFERENCES "public"."deal"("id") ON DELETE cascade ON UPDATE cascade;
--> statement-breakpoint
ALTER TABLE "dealContact" ADD CONSTRAINT "dealContact_contactId_fkey" FOREIGN KEY ("contactId") REFERENCES "public"."contact"("id") ON DELETE cascade ON UPDATE cascade;
--> statement-breakpoint
ALTER TABLE "emailMessage" ADD CONSTRAINT "emailMessage_threadId_fkey" FOREIGN KEY ("threadId") REFERENCES "public"."emailThread"("id") ON DELETE cascade ON UPDATE cascade;
--> statement-breakpoint
ALTER TABLE "emailThread" ADD CONSTRAINT "emailThread_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "public"."company"("id") ON DELETE set null ON UPDATE cascade;
--> statement-breakpoint
ALTER TABLE "emailThread" ADD CONSTRAINT "emailThread_contactId_fkey" FOREIGN KEY ("contactId") REFERENCES "public"."contact"("id") ON DELETE set null ON UPDATE cascade;
--> statement-breakpoint
ALTER TABLE "fieldOption" ADD CONSTRAINT "fieldOption_fieldId_fkey" FOREIGN KEY ("fieldId") REFERENCES "public"."fieldDefinition"("id") ON DELETE cascade ON UPDATE cascade;
--> statement-breakpoint
ALTER TABLE "fieldValue" ADD CONSTRAINT "fieldValue_fieldId_fkey" FOREIGN KEY ("fieldId") REFERENCES "public"."fieldDefinition"("id") ON DELETE cascade ON UPDATE cascade;
--> statement-breakpoint
ALTER TABLE "fieldValue" ADD CONSTRAINT "fieldValue_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "public"."company"("id") ON DELETE cascade ON UPDATE cascade;
--> statement-breakpoint
ALTER TABLE "fieldValue" ADD CONSTRAINT "fieldValue_contactId_fkey" FOREIGN KEY ("contactId") REFERENCES "public"."contact"("id") ON DELETE cascade ON UPDATE cascade;
--> statement-breakpoint
ALTER TABLE "fieldValue" ADD CONSTRAINT "fieldValue_dealId_fkey" FOREIGN KEY ("dealId") REFERENCES "public"."deal"("id") ON DELETE cascade ON UPDATE cascade;
--> statement-breakpoint
ALTER TABLE "fieldValue" ADD CONSTRAINT "fieldValue_optionId_fkey" FOREIGN KEY ("optionId") REFERENCES "public"."fieldOption"("id") ON DELETE set null ON UPDATE cascade;
--> statement-breakpoint
ALTER TABLE "fieldValue" ADD CONSTRAINT "fieldValue_userId_fkey" FOREIGN KEY ("userId") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE cascade;
--> statement-breakpoint
ALTER TABLE "formSubmission" ADD CONSTRAINT "formSubmission_contactId_fkey" FOREIGN KEY ("contactId") REFERENCES "public"."contact"("id") ON DELETE set null ON UPDATE cascade;
--> statement-breakpoint
ALTER TABLE "invitation" ADD CONSTRAINT "invitation_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE cascade;
--> statement-breakpoint
ALTER TABLE "invitation" ADD CONSTRAINT "invitation_inviterId_fkey" FOREIGN KEY ("inviterId") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE cascade;
--> statement-breakpoint
ALTER TABLE "mailboxSync" ADD CONSTRAINT "mailboxSync_userId_fkey" FOREIGN KEY ("userId") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE cascade;
--> statement-breakpoint
ALTER TABLE "mcpConnection" ADD CONSTRAINT "mcpConnection_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE cascade;
--> statement-breakpoint
ALTER TABLE "mcpConnection" ADD CONSTRAINT "mcpConnection_registrationId_fkey" FOREIGN KEY ("registrationId") REFERENCES "public"."mcpClientRegistration"("id") ON DELETE restrict ON UPDATE cascade;
--> statement-breakpoint
ALTER TABLE "mcpConnection" ADD CONSTRAINT "mcpConnection_connectedById_fkey" FOREIGN KEY ("connectedById") REFERENCES "public"."user"("id") ON DELETE restrict ON UPDATE cascade;
--> statement-breakpoint
ALTER TABLE "mcpOauthState" ADD CONSTRAINT "mcpOauthState_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE cascade;
--> statement-breakpoint
ALTER TABLE "mcpOauthState" ADD CONSTRAINT "mcpOauthState_userId_fkey" FOREIGN KEY ("userId") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE cascade;
--> statement-breakpoint
ALTER TABLE "mcpOauthState" ADD CONSTRAINT "mcpOauthState_registrationId_fkey" FOREIGN KEY ("registrationId") REFERENCES "public"."mcpClientRegistration"("id") ON DELETE cascade ON UPDATE cascade;
--> statement-breakpoint
ALTER TABLE "mcpToolSnapshot" ADD CONSTRAINT "mcpToolSnapshot_connectionId_fkey" FOREIGN KEY ("connectionId") REFERENCES "public"."mcpConnection"("id") ON DELETE cascade ON UPDATE cascade;
--> statement-breakpoint
ALTER TABLE "member" ADD CONSTRAINT "member_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE cascade;
--> statement-breakpoint
ALTER TABLE "member" ADD CONSTRAINT "member_userId_fkey" FOREIGN KEY ("userId") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE cascade;
--> statement-breakpoint
ALTER TABLE "savedView" ADD CONSTRAINT "savedView_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE cascade;
--> statement-breakpoint
ALTER TABLE "session" ADD CONSTRAINT "session_userId_fkey" FOREIGN KEY ("userId") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE cascade;
--> statement-breakpoint
ALTER TABLE "slackMemberMatch" ADD CONSTRAINT "slackMemberMatch_crmUserId_fkey" FOREIGN KEY ("crmUserId") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE cascade;
--> statement-breakpoint
ALTER TABLE "ssoProvider" ADD CONSTRAINT "ssoProvider_userId_fkey" FOREIGN KEY ("userId") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE cascade;
--> statement-breakpoint
ALTER TABLE "trackedVisitor" ADD CONSTRAINT "trackedVisitor_contactId_fkey" FOREIGN KEY ("contactId") REFERENCES "public"."contact"("id") ON DELETE set null ON UPDATE cascade;
--> statement-breakpoint
INSERT INTO "install" ("id", "uuid", "version", "updatedAt") VALUES ('install', gen_random_uuid()::text, 'unknown', CURRENT_TIMESTAMP) ON CONFLICT ("id") DO NOTHING;

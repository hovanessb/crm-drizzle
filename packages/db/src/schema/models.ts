import type * as schema from "./schema";

export type User = typeof schema.user.$inferSelect;
export type NewUser = typeof schema.user.$inferInsert;
export type SlackMemberMatch = typeof schema.slackMemberMatch.$inferSelect;
export type NewSlackMemberMatch = typeof schema.slackMemberMatch.$inferInsert;
export type SlackChannel = typeof schema.slackChannel.$inferSelect;
export type NewSlackChannel = typeof schema.slackChannel.$inferInsert;
export type SlackInstallation = typeof schema.slackInstallation.$inferSelect;
export type NewSlackInstallation = typeof schema.slackInstallation.$inferInsert;
export type SlackWorkspaceGrant =
	typeof schema.slackWorkspaceGrant.$inferSelect;
export type NewSlackWorkspaceGrant =
	typeof schema.slackWorkspaceGrant.$inferInsert;
export type Session = typeof schema.session.$inferSelect;
export type NewSession = typeof schema.session.$inferInsert;
export type Account = typeof schema.account.$inferSelect;
export type NewAccount = typeof schema.account.$inferInsert;
export type McpConnection = typeof schema.mcpConnection.$inferSelect;
export type NewMcpConnection = typeof schema.mcpConnection.$inferInsert;
export type McpClientRegistration =
	typeof schema.mcpClientRegistration.$inferSelect;
export type NewMcpClientRegistration =
	typeof schema.mcpClientRegistration.$inferInsert;
export type McpToolSnapshot = typeof schema.mcpToolSnapshot.$inferSelect;
export type NewMcpToolSnapshot = typeof schema.mcpToolSnapshot.$inferInsert;
export type McpOauthState = typeof schema.mcpOauthState.$inferSelect;
export type NewMcpOauthState = typeof schema.mcpOauthState.$inferInsert;
export type Verification = typeof schema.verification.$inferSelect;
export type NewVerification = typeof schema.verification.$inferInsert;
export type RateLimit = typeof schema.rateLimit.$inferSelect;
export type NewRateLimit = typeof schema.rateLimit.$inferInsert;
export type Company = typeof schema.company.$inferSelect;
export type NewCompany = typeof schema.company.$inferInsert;
export type CompanyEnrichment = typeof schema.companyEnrichment.$inferSelect;
export type NewCompanyEnrichment = typeof schema.companyEnrichment.$inferInsert;
export type Contact = typeof schema.contact.$inferSelect;
export type NewContact = typeof schema.contact.$inferInsert;
export type ContactFact = typeof schema.contactFact.$inferSelect;
export type NewContactFact = typeof schema.contactFact.$inferInsert;
export type ContactBrief = typeof schema.contactBrief.$inferSelect;
export type NewContactBrief = typeof schema.contactBrief.$inferInsert;
export type AgentTask = typeof schema.agentTask.$inferSelect;
export type NewAgentTask = typeof schema.agentTask.$inferInsert;
export type AgentEvent = typeof schema.agentEvent.$inferSelect;
export type NewAgentEvent = typeof schema.agentEvent.$inferInsert;
export type AgentConversation = typeof schema.agentConversation.$inferSelect;
export type NewAgentConversation = typeof schema.agentConversation.$inferInsert;
export type AgentConversationFeedback =
	typeof schema.agentConversationFeedback.$inferSelect;
export type NewAgentConversationFeedback =
	typeof schema.agentConversationFeedback.$inferInsert;
export type AgentConversationShare =
	typeof schema.agentConversationShare.$inferSelect;
export type NewAgentConversationShare =
	typeof schema.agentConversationShare.$inferInsert;
export type AgentConversationSubmission =
	typeof schema.agentConversationSubmission.$inferSelect;
export type NewAgentConversationSubmission =
	typeof schema.agentConversationSubmission.$inferInsert;
export type AgentConversationAttachment =
	typeof schema.agentConversationAttachment.$inferSelect;
export type NewAgentConversationAttachment =
	typeof schema.agentConversationAttachment.$inferInsert;
export type AgentDefinition = typeof schema.agentDefinition.$inferSelect;
export type NewAgentDefinition = typeof schema.agentDefinition.$inferInsert;
export type AgentVersion = typeof schema.agentVersion.$inferSelect;
export type NewAgentVersion = typeof schema.agentVersion.$inferInsert;
export type AgentBuilderArtifact =
	typeof schema.agentBuilderArtifact.$inferSelect;
export type NewAgentBuilderArtifact =
	typeof schema.agentBuilderArtifact.$inferInsert;
export type AgentTrigger = typeof schema.agentTrigger.$inferSelect;
export type NewAgentTrigger = typeof schema.agentTrigger.$inferInsert;
export type AgentRun = typeof schema.agentRun.$inferSelect;
export type NewAgentRun = typeof schema.agentRun.$inferInsert;
export type AgentRunEvent = typeof schema.agentRunEvent.$inferSelect;
export type NewAgentRunEvent = typeof schema.agentRunEvent.$inferInsert;
export type AgentAction = typeof schema.agentAction.$inferSelect;
export type NewAgentAction = typeof schema.agentAction.$inferInsert;
export type AgentAuditEvent = typeof schema.agentAuditEvent.$inferSelect;
export type NewAgentAuditEvent = typeof schema.agentAuditEvent.$inferInsert;
export type Deal = typeof schema.deal.$inferSelect;
export type NewDeal = typeof schema.deal.$inferInsert;
export type ExchangeRate = typeof schema.exchangeRate.$inferSelect;
export type NewExchangeRate = typeof schema.exchangeRate.$inferInsert;
export type DealContact = typeof schema.dealContact.$inferSelect;
export type NewDealContact = typeof schema.dealContact.$inferInsert;
export type FieldDefinition = typeof schema.fieldDefinition.$inferSelect;
export type NewFieldDefinition = typeof schema.fieldDefinition.$inferInsert;
export type FieldOption = typeof schema.fieldOption.$inferSelect;
export type NewFieldOption = typeof schema.fieldOption.$inferInsert;
export type FieldValue = typeof schema.fieldValue.$inferSelect;
export type NewFieldValue = typeof schema.fieldValue.$inferInsert;
export type SavedView = typeof schema.savedView.$inferSelect;
export type NewSavedView = typeof schema.savedView.$inferInsert;
export type Activity = typeof schema.activity.$inferSelect;
export type NewActivity = typeof schema.activity.$inferInsert;
export type MailboxSync = typeof schema.mailboxSync.$inferSelect;
export type NewMailboxSync = typeof schema.mailboxSync.$inferInsert;
export type EmailThread = typeof schema.emailThread.$inferSelect;
export type NewEmailThread = typeof schema.emailThread.$inferInsert;
export type EmailMessage = typeof schema.emailMessage.$inferSelect;
export type NewEmailMessage = typeof schema.emailMessage.$inferInsert;
export type CalendarEvent = typeof schema.calendarEvent.$inferSelect;
export type NewCalendarEvent = typeof schema.calendarEvent.$inferInsert;
export type CalendarAttendee = typeof schema.calendarAttendee.$inferSelect;
export type NewCalendarAttendee = typeof schema.calendarAttendee.$inferInsert;
export type SuppressedDomain = typeof schema.suppressedDomain.$inferSelect;
export type NewSuppressedDomain = typeof schema.suppressedDomain.$inferInsert;
export type SuppressedContact = typeof schema.suppressedContact.$inferSelect;
export type NewSuppressedContact = typeof schema.suppressedContact.$inferInsert;
export type AppSetting = typeof schema.appSetting.$inferSelect;
export type NewAppSetting = typeof schema.appSetting.$inferInsert;
export type TrackedDomain = typeof schema.trackedDomain.$inferSelect;
export type NewTrackedDomain = typeof schema.trackedDomain.$inferInsert;
export type TrackedVisitor = typeof schema.trackedVisitor.$inferSelect;
export type NewTrackedVisitor = typeof schema.trackedVisitor.$inferInsert;
export type TrackedEvent = typeof schema.trackedEvent.$inferSelect;
export type NewTrackedEvent = typeof schema.trackedEvent.$inferInsert;
export type TrackingCounter = typeof schema.trackingCounter.$inferSelect;
export type NewTrackingCounter = typeof schema.trackingCounter.$inferInsert;
export type TrackedPageDaily = typeof schema.trackedPageDaily.$inferSelect;
export type NewTrackedPageDaily = typeof schema.trackedPageDaily.$inferInsert;
export type FormSubmission = typeof schema.formSubmission.$inferSelect;
export type NewFormSubmission = typeof schema.formSubmission.$inferInsert;
export type Install = typeof schema.install.$inferSelect;
export type NewInstall = typeof schema.install.$inferInsert;
export type TelemetryMilestone = typeof schema.telemetryMilestone.$inferSelect;
export type NewTelemetryMilestone =
	typeof schema.telemetryMilestone.$inferInsert;
export type TelemetryCounter = typeof schema.telemetryCounter.$inferSelect;
export type NewTelemetryCounter = typeof schema.telemetryCounter.$inferInsert;
export type Organization = typeof schema.organization.$inferSelect;
export type NewOrganization = typeof schema.organization.$inferInsert;
export type WorkspaceProfile = typeof schema.workspaceProfile.$inferSelect;
export type NewWorkspaceProfile = typeof schema.workspaceProfile.$inferInsert;
export type Member = typeof schema.member.$inferSelect;
export type NewMember = typeof schema.member.$inferInsert;
export type Invitation = typeof schema.invitation.$inferSelect;
export type NewInvitation = typeof schema.invitation.$inferInsert;
export type SsoProvider = typeof schema.ssoProvider.$inferSelect;
export type NewSsoProvider = typeof schema.ssoProvider.$inferInsert;
export type Apikey = typeof schema.apikey.$inferSelect;
export type NewApikey = typeof schema.apikey.$inferInsert;

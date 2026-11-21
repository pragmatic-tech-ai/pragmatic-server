import type { ServerResponse } from 'node:http'
import { JsonApi, ProblemMapper } from '@pragmatic-tech-ai/pragmatic-app-host'
import {
    CreateFailedError,
    DockerUnavailableError,
    EnvironmentExistsError,
    EnvironmentNotFoundError,
    ImageMissingError,
    EnvironmentNotDevelopmentError,
    EnvironmentNotRuntimeError
} from './environment-service.js'
import { GraphExistsError, GraphNameInvalidError, GraphNotFoundError } from './graph-service.js'
import { InvalidTenantIdError } from './idp-service.js'
import { PortUnavailableError } from './port-allocator.js'
import { IdpUnreachableError, OwnerAccountMissingError, OwnerIdpRefusedError, OwnerNotRecordedError, OwnerResetInProgressError, TenantIdpMissingError } from './tenant-provisioning-service.js'
import { InvalidEnvironmentNameError } from './template-catalog.js'
import { LastOperatorError, OperatorExistsError, OperatorNotFoundError, OperatorProtectedError, OperatorSelfLockoutError } from './operator-identity.js'
import { AdminProxyError, AdminProxyErrorKind } from './admin-proxy.js'
import { RecordUnstorableError } from './record-map.js'
import { ClientHasTenantsError, HiveHasEnvironmentsError, InHiveConsoleTakenError, RecordExistsError, TenantClientMismatchError, TenantHasHivesError, UnknownClientError, UnknownTenantError } from './platform-directory.js'
import { HivePlacementError } from './hive-placement-error.js'
import { InvalidEmailDomainError } from './email-domain-policy.js'
import { EmailDomainApprovalRefusedError } from './platform-email-domains.js'
import { DomainNotClaimedError, DomainVerificationUnavailableError, DomainVerifyThrottledError, EmailDomainsNotEditableError } from './tenant-api/tenant-email-domains.js'
import { InvalidHiveConsoleError } from './hive-console-spec.js'
import { InvalidIngressTlsError } from './ingress-tls.js'
import { AgentInstallInProgressError, AgentInstallUnavailableError } from './hive-agent-installer.js'
import { AgentUninstallError, ConsoleUninstallError, HiveClusterDestroyError } from './hive-agent-uninstaller.js'
import { ConsoleInstallInProgressError, ConsoleInstallUnavailableError, ConsoleNotConfiguredError } from './tenant-console-installer.js'
import { InHiveIdpUnavailableError } from './in-hive-idp-admin.js'
import { InvalidRecordIdError } from './platform-records.js'
import { UnsupportedBackendError } from './hive-orchestrator.js'
import { NoInfraTargetBackendError, NoInfraTargetError } from './no-infra-target.js'
import { HostedClusterRefMissingError } from './hosted-hive-orchestrator-factory.js'
import { KubectlError, PortForwardError } from '@pragmatic-tech-ai/pragmatic-kube'
import { BodyTooLargeError, ChannelNotSubscribedError, HiveNotRegisteredError, ManifestExistsError, ManifestNotGatedError, ManifestWithdrawnError, PolicyStoreUnavailableError, ReleaseNotRunnableYetError, ReleaseRegistryUnavailableError, ReleaseRejectedError, TenantOnHoldError, UnknownHiveError, UnknownManifestError, VersionBelowFloorError } from '@pragmatic-tech-ai/pragmatic-platform-link'

/**
 * The platform admin console's domain error -> HTTP status table, as the host's ProblemMapper registration (the table the
 * console host kept before it moved onto pragmatic-app-host). A registered 5xx is masked as the generic 500 unless it is a
 * 503 or registered unmasked. An environment admin-proxy failure answers by its kind: a dead environment is 503 with a
 * fixed sentence (logged), a refused change 409, an invalid request 400, anything else the masked 500.
 */
export class ControlPlaneProblems extends ProblemMapper
{
    private static readonly CodeBadRequest = 400
    private static readonly CodeForbidden = 403
    private static readonly CodeNotFound = 404
    private static readonly CodeConflict = 409
    private static readonly CodeTooLarge = 413
    private static readonly CodeTooManyRequests = 429
    private static readonly CodeInternal = 500
    private static readonly CodeBadGateway = 502
    private static readonly CodeUnavailable = 503
    private static readonly ErrorKey = 'error'
    private static readonly ConnectUnavailableMessage = 'Environment is not reachable'
    private static readonly LogPrefix = '[control-plane] request failed:'

    public constructor(private readonly logError: (...items: unknown[]) => void = console.error)
    {
        super(err => logError(ControlPlaneProblems.LogPrefix, err))
        const P = ControlPlaneProblems
        this.Register(BodyTooLargeError, P.CodeTooLarge)
            .Register(RecordUnstorableError, P.CodeBadRequest)
            .Register(InvalidEnvironmentNameError, P.CodeBadRequest)
            .Register(EnvironmentNotFoundError, P.CodeNotFound)
            .Register(EnvironmentExistsError, P.CodeConflict)
            .Register(OperatorExistsError, P.CodeConflict)
            .Register(OperatorSelfLockoutError, P.CodeConflict)
            .Register(LastOperatorError, P.CodeConflict)
            .Register(OperatorProtectedError, P.CodeConflict)
            .Register(OperatorNotFoundError, P.CodeNotFound)
            .Register(PortUnavailableError, P.CodeConflict)
            .Register(ImageMissingError, P.CodeConflict, err => ({ buildCommand: (err as ImageMissingError).buildCommand }))
            .Register(DockerUnavailableError, P.CodeUnavailable)
            .Register(CreateFailedError, P.CodeInternal)
            .Register(GraphExistsError, P.CodeConflict)
            .Register(GraphNotFoundError, P.CodeNotFound)
            .Register(GraphNameInvalidError, P.CodeBadRequest)
            .Register(EnvironmentNotDevelopmentError, P.CodeBadRequest)
            .Register(EnvironmentNotRuntimeError, P.CodeBadRequest)
            .Register(InvalidRecordIdError, P.CodeBadRequest)
            .Register(InvalidTenantIdError, P.CodeBadRequest)
            .Register(RecordExistsError, P.CodeConflict)
            .Register(TenantClientMismatchError, P.CodeBadRequest)
            .Register(UnknownClientError, P.CodeNotFound)
            .Register(UnknownTenantError, P.CodeNotFound)
            .Register(ClientHasTenantsError, P.CodeConflict)
            .Register(TenantHasHivesError, P.CodeConflict)
            .Register(HiveHasEnvironmentsError, P.CodeConflict)
            .Register(HivePlacementError, P.CodeConflict)
            .Register(UnsupportedBackendError, P.CodeBadRequest)
            // D28 interim: this admin has no Docker/cluster target; 503 passes the plain sentence through unmasked.
            .Register(NoInfraTargetError, P.CodeUnavailable)
            .Register(NoInfraTargetBackendError, P.CodeUnavailable)
            .Register(HostedClusterRefMissingError, P.CodeBadRequest)
            .Register(KubectlError, P.CodeBadGateway)
            // The tenant is not authorized to that version (it was never gated to it): forbidden, not missing.
            .Register(ManifestNotGatedError, P.CodeForbidden)
            .Register(UnknownManifestError, P.CodeNotFound)
            // Release-policy refusals: state conflicts are 409; a channel the tenant is not subscribed to is forbidden; an
            // unreadable policy store fails closed as 500.
            .Register(ManifestWithdrawnError, P.CodeConflict)
            .Register(TenantOnHoldError, P.CodeConflict)
            .Register(ChannelNotSubscribedError, P.CodeForbidden)
            .Register(VersionBelowFloorError, P.CodeConflict)
            .Register(PolicyStoreUnavailableError, P.CodeInternal)
            .Register(ManifestExistsError, P.CodeConflict)
            // Registry releases: a rejected one can never be gated, a verified one cannot be run by hives yet (each a plain
            // sentence); a registry that is down or refuses the credential is a bad gateway with its fixed, token-free sentence.
            .Register(ReleaseRejectedError, P.CodeConflict)
            .Register(ReleaseNotRunnableYetError, P.CodeConflict)
            .RegisterUnmasked(ReleaseRegistryUnavailableError, P.CodeBadGateway)
            .Register(HiveNotRegisteredError, P.CodeNotFound)
            .Register(UnknownHiveError, P.CodeNotFound)
            .Register(AgentInstallUnavailableError, P.CodeConflict)
            .Register(AgentInstallInProgressError, P.CodeConflict)
            .Register(InvalidHiveConsoleError, P.CodeBadRequest)
            .Register(InvalidIngressTlsError, P.CodeBadRequest)
            .Register(InHiveConsoleTakenError, P.CodeConflict)
            .Register(ConsoleNotConfiguredError, P.CodeConflict)
            .Register(ConsoleInstallUnavailableError, P.CodeConflict)
            .Register(ConsoleInstallInProgressError, P.CodeConflict)
            .Register(InHiveIdpUnavailableError, P.CodeConflict)
            // The hive's cluster refused or could not be reached while its agent was being removed: the operator fixes
            // cluster access and retries, or deletes anyway. The code lets the portal offer delete anyway for exactly this.
            .Register(AgentUninstallError, P.CodeConflict, () => ({ code: AgentUninstallError.Code }))
            // The console (or its environment namespaces) could not be removed: same remedy and code as the agent's removal.
            .Register(ConsoleUninstallError, P.CodeConflict, () => ({ code: AgentUninstallError.Code }))
            // The tunnel to an in-hive IdP did not open (its pod is down or not ready): unavailable, not a masked server error.
            .Register(PortForwardError, P.CodeUnavailable)
            // A provisioned hive's kind cluster could not be destroyed (kind / Docker down): fix it and retry, or delete anyway.
            .Register(HiveClusterDestroyError, P.CodeConflict, () => ({ code: HiveClusterDestroyError.Code }))
            // Owner password reset: state the operator must fix -> 409; an unreachable tenant IdP -> 503 (not masked).
            .Register(OwnerNotRecordedError, P.CodeConflict)
            .Register(TenantIdpMissingError, P.CodeConflict)
            .Register(OwnerAccountMissingError, P.CodeConflict)
            .Register(OwnerIdpRefusedError, P.CodeConflict)
            .Register(IdpUnreachableError, P.CodeUnavailable)
            .Register(OwnerResetInProgressError, P.CodeConflict)
            // Email domains: a refused domain or list -> 400; an in-hive tenant's domains (set in its console) or an approval
            // that cannot apply -> 409. Each message is one plain sentence (it may name the domain the operator typed).
            .Register(InvalidEmailDomainError, P.CodeBadRequest)
            .Register(EmailDomainsNotEditableError, P.CodeConflict)
            .Register(EmailDomainApprovalRefusedError, P.CodeConflict)
            // DNS verification: a domain the tenant does not claim -> 409; too many lookups -> 429; no verifier or a lookup
            // that did not complete -> 503 (nothing stored). Each message is one plain sentence.
            .Register(DomainNotClaimedError, P.CodeConflict)
            .Register(DomainVerifyThrottledError, P.CodeTooManyRequests)
            .Register(DomainVerificationUnavailableError, P.CodeUnavailable)
    }

    public override Write(res: ServerResponse, err: unknown): void
    {
        if (!(err instanceof AdminProxyError) || res.headersSent)
        {
            super.Write(res, err)
            return
        }
        const P = ControlPlaneProblems
        switch (err.Kind)
        {
            case AdminProxyErrorKind.Connect:
                this.logError(P.LogPrefix, err)
                JsonApi.WriteJson(res, P.CodeUnavailable, { [P.ErrorKey]: P.ConnectUnavailableMessage })
                return
            case AdminProxyErrorKind.Rbac:
                JsonApi.WriteJson(res, P.CodeConflict, { [P.ErrorKey]: err.message })
                return
            case AdminProxyErrorKind.Invalid:
                JsonApi.WriteJson(res, P.CodeBadRequest, { [P.ErrorKey]: err.message })
                return
            default:
                super.Write(res, err)
        }
    }
}

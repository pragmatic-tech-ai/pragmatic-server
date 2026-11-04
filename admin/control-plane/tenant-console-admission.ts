/** The names the console's admission fence is rendered from (all supplied by K8sManifestBuilder). */
export interface TenantConsoleAdmissionSpec
{
    /** Name of the ValidatingAdmissionPolicy and of its binding. */
    name: string
    labels: Record<string, string>
    hiveId: string
    hiveLabel: string
    /** Pod Security Admission enforce label a created namespace must carry, with one of `podSecurityLevels`. */
    podSecurityLabel: string
    podSecurityLevels: ReadonlyArray<string>
    namespacePrefix: string
    serviceAccountName: string
    serviceAccountNamespace: string
    envRoleName: string
    envBindingName: string
}

/**
 * The per-console ValidatingAdmissionPolicy + binding (admissionregistration.k8s.io/v1, Kubernetes >= 1.30) that fences the
 * console's cluster-wide RBAC: RBAC cannot restrict names by prefix or label, so the API server itself refuses any console
 * request on a Namespace that is not one of this hive's `pragmatic-env-` namespaces (a created one must also enforce the
 * baseline or restricted Pod Security level, so the env role cannot run a privileged pod there), and any RoleBinding other than the
 * console's own env binding (its env ClusterRole, its ServiceAccount as the only subject) in such a namespace. It applies
 * only to the console's exact ServiceAccount user and fails closed. The console has no admissionregistration grants.
 */
export class TenantConsoleAdmission
{
    public static readonly ApiVersion = 'admissionregistration.k8s.io/v1'
    public static readonly PolicyKind = 'ValidatingAdmissionPolicy'
    public static readonly BindingKind = 'ValidatingAdmissionPolicyBinding'
    private static readonly FailurePolicy = 'Fail'
    private static readonly DenyAction = 'Deny'
    private static readonly CoreGroup = ''
    private static readonly CoreVersion = 'v1'
    private static readonly RbacGroup = 'rbac.authorization.k8s.io'
    private static readonly RbacVersion = 'v1'
    private static readonly NamespacesResource = 'namespaces'
    private static readonly RoleBindingsResource = 'rolebindings'
    private static readonly Create = 'CREATE'
    private static readonly Update = 'UPDATE'
    private static readonly Delete = 'DELETE'
    private static readonly ClusterRoleKind = 'ClusterRole'
    private static readonly ServiceAccountKind = 'ServiceAccount'
    private static readonly ServiceAccountUserPrefix = 'system:serviceaccount:'
    private static readonly UserSeparator = ':'
    private static readonly MatchConditionName = 'console-service-account'
    private static readonly Quote = "'"
    private static readonly Backslash = /\\/g
    private static readonly QuoteChar = /'/g
    private static readonly EscapedBackslash = '\\\\'
    private static readonly EscapedQuote = "\\'"
    private static readonly NamespaceCreateMessage = 'The console may only create its own hive\'s environment namespaces, enforcing the baseline or restricted Pod Security level.'
    private static readonly NamespaceChangeMessage = 'The console may only change or delete its own hive\'s environment namespaces.'
    private static readonly BindingNamespaceMessage = 'The console may only bind roles inside its own hive\'s environment namespaces.'
    private static readonly BindingNameMessage = 'The console may only create its own environment role binding.'
    private static readonly BindingRoleMessage = 'The console may only bind its own environment ClusterRole.'
    private static readonly BindingSubjectsMessage = 'The console may only bind its environment role to its own ServiceAccount.'

    public static Policy(spec: TenantConsoleAdmissionSpec): Record<string, unknown>
    {
        const C = TenantConsoleAdmission
        return {
            apiVersion: C.ApiVersion,
            kind: C.PolicyKind,
            metadata: { name: spec.name, labels: spec.labels },
            spec: {
                failurePolicy: C.FailurePolicy,
                matchConstraints: {
                    resourceRules: [
                        { apiGroups: [C.CoreGroup], apiVersions: [C.CoreVersion], operations: [C.Create, C.Update, C.Delete], resources: [C.NamespacesResource] },
                        { apiGroups: [C.RbacGroup], apiVersions: [C.RbacVersion], operations: [C.Create, C.Update], resources: [C.RoleBindingsResource] },
                    ],
                },
                matchConditions: [{ name: C.MatchConditionName, expression: C.UserCondition(spec) }],
                validations: C.Validations(spec),
            },
        }
    }

    public static Binding(spec: TenantConsoleAdmissionSpec): Record<string, unknown>
    {
        const C = TenantConsoleAdmission
        return {
            apiVersion: C.ApiVersion,
            kind: C.BindingKind,
            metadata: { name: spec.name, labels: spec.labels },
            spec: { policyName: spec.name, validationActions: [C.DenyAction] },
        }
    }

    /** A CEL single-quoted string literal of `value` (backslashes and quotes escaped), so no value can break out of an expression. */
    public static CelString(value: string): string
    {
        const C = TenantConsoleAdmission
        return C.Quote + value.replace(C.Backslash, C.EscapedBackslash).replace(C.QuoteChar, C.EscapedQuote) + C.Quote
    }

    private static UserCondition(spec: TenantConsoleAdmissionSpec): string
    {
        const C = TenantConsoleAdmission
        const user = C.ServiceAccountUserPrefix + spec.serviceAccountNamespace + C.UserSeparator + spec.serviceAccountName
        return `request.userInfo.username == ${C.CelString(user)}`
    }

    private static Validations(spec: TenantConsoleAdmissionSpec): Array<{ expression: string; message: string }>
    {
        const C = TenantConsoleAdmission
        const s = C.CelString
        const isNamespace = `request.resource.resource != ${s(C.NamespacesResource)}`
        const isBinding = `request.resource.resource != ${s(C.RoleBindingsResource)}`
        const create = s(C.Create)
        return [
            {
                expression: `${isNamespace} || request.operation != ${create} || (${C.OwnNamespace(spec, 'object.metadata.name', 'object')} && ${C.PodSecurityEnforced(spec, 'object')})`,
                message: C.NamespaceCreateMessage,
            },
            {
                expression: `${isNamespace} || request.operation == ${create} || (${C.OwnNamespace(spec, 'oldObject.metadata.name', 'oldObject')})`,
                message: C.NamespaceChangeMessage,
            },
            {
                expression: `${isBinding} || (${C.OwnNamespace(spec, 'request.namespace', 'namespaceObject')})`,
                message: C.BindingNamespaceMessage,
            },
            {
                expression: `${isBinding} || object.metadata.name == ${s(spec.envBindingName)}`,
                message: C.BindingNameMessage,
            },
            {
                expression: `${isBinding} || (object.roleRef.apiGroup == ${s(C.RbacGroup)} && object.roleRef.kind == ${s(C.ClusterRoleKind)} && object.roleRef.name == ${s(spec.envRoleName)})`,
                message: C.BindingRoleMessage,
            },
            {
                expression: `${isBinding} || (has(object.subjects) && size(object.subjects) == 1 && object.subjects[0].kind == ${s(C.ServiceAccountKind)} && object.subjects[0].namespace == ${s(spec.serviceAccountNamespace)} && object.subjects[0].name == ${s(spec.serviceAccountName)})`,
                message: C.BindingSubjectsMessage,
            },
        ]
    }

    /** `<objectExpr>` enforces an admitted Pod Security level (follows OwnNamespace, which already guarded has(labels)). */
    private static PodSecurityEnforced(spec: TenantConsoleAdmissionSpec, objectExpr: string): string
    {
        const s = TenantConsoleAdmission.CelString
        const labels = `${objectExpr}.metadata.labels`
        const label = s(spec.podSecurityLabel)
        return `${label} in ${labels} && ${labels}[${label}] in [${spec.podSecurityLevels.map(s).join(', ')}]`
    }

    /** `<nameExpr>` has the env prefix and `<objectExpr>` carries this hive's label (a missing label map or key is a refusal, not an error). */
    private static OwnNamespace(spec: TenantConsoleAdmissionSpec, nameExpr: string, objectExpr: string): string
    {
        const s = TenantConsoleAdmission.CelString
        const labels = `${objectExpr}.metadata.labels`
        const label = s(spec.hiveLabel)
        return `${nameExpr}.startsWith(${s(spec.namespacePrefix)}) && has(${labels}) && ${label} in ${labels} && ${labels}[${label}] == ${s(spec.hiveId)}`
    }
}

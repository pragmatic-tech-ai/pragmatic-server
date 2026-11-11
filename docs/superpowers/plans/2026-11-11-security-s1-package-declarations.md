# S1: Package Security Declarations in TODL, Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A TODL package declares its layer-4 security (owned concepts via `todl.system.Owned`, package roles, base-role contributions, secured fields, field profiles). The compiler validates it and compiles it to `IPackageSecurity`. The environment composer unions it into `IEnvironmentSecurity` and swaps it with the catalog. The engine bridge places `owner`/`owningBusinessUnit` on create, and only an assign operation changes them. TODL's tier-2 policy code is removed.

**Architecture:** The `todl.system` package gains the `Owned` aspect. Its compiled document becomes an implicit compile foundation beside the prelude, so `todl.system.Owned` resolves while authoring and compiling. A package that uses it records `todl.system@1.0.0` as a dependency, and the runtime loads it like any other dependency. New top-level declarations (`role`, `contribute`, `profile`) and a `secured` field modifier are lowered into ontology nodes and checked by a `SecurityValidator`. `compilePackage` then projects them into `IPackageSecurity` and persists it on the own-only document. The engine bridge reads that projection: it composes the environment security, places system fields through placement `Defaults` (replayed by the engine through `GraphTransaction.SetDefault`), guards system fields read-only on every runtime scope, and changes them only through `OwnershipAssignment`.

**Tech Stack:** TypeScript (ESM, strict), `node:test` via `tsx --conditions=development --test`, `@pragmatic-tech-ai/graph` (engine; imported only under `src/engine-bridge/`).

**Spec:** `pragmatic-server/docs/superpowers/specs/2026-11-11-platform-security-architecture-design.md`. Program index and shared contracts C1–C7: `pragmatic-server/docs/superpowers/plans/2026-11-11-platform-security-program.md`. The index wins over this plan, and the spec wins over the index. The index's program rulings PR1–PR18 win over this plan; S1 carries PR1, PR2, PR4, PR8, PR12, PR16 and PR17.

## Global Constraints

- **Start condition:** do not execute until M2.2 (`feat/m2.2-runtime-on-engine`) has merged to TODL `main`. Branch `feat/security-s1-package-declarations` from that `main`. Line anchors in this plan were captured on the M2.2 branch, so trust symbol names over line numbers and re-grep before editing.
- **Merge order (program ruling PR17):** Task 1 deletes `PolicyScopeCompiler`, which pragmatic-server imports until S4 Task 2. The S1 branch merges to TODL `main` (and TODL is rebuilt for its dependents) only after S4 Task 2 is on pragmatic-server `master`. Task 11 also waits on S2 Task 6 (`ConnectorContext`).
- Repo: `D:\architecture-agent\TODL` (default branch `main`). Commit per task. Never push without an explicit owner instruction.
- **Never run `npm install`** (it breaks the workspace symlinks). Use the installed `node_modules`. Do not force-remove a worktree or any directory that contains `node_modules` links.
- OOP only: no module-level functions or variables. Every function is a method or static member of a class. Module-level `const` is allowed only for true compile-time constants, types and enums. Existing legacy free functions you touch (`checkAgainst`, `compilePackage`, `loadInto`) keep their shape. New code goes in classes.
- Allman braces for every class, method and control-flow block (`else`/`catch`/`finally` on their own line). Object literals, arrow bodies and true one-liners stay inline.
- PascalCase for interfaces, interface members, and every new public method (`DefineRole`, not `defineRole`). Plain JSON data shapes keep their serialized casing (`PackageDocument.security`).
- No inline string literals: user-facing messages, attr keys, keywords and reused literals become `private static readonly` (or `public static readonly` when shared) PascalCase constants. Exceptions: `typeof` guards and single-use structural tokens.
- Enums over string literals: actions, depths, base roles, profile rights, meta-kinds, diagnostic codes and error codes are enums.
- Every test file lives in a `tests/` subfolder next to the code it tests. Naming: kebab-case under `compiler-services/` and `publish/`, PascalCase under `engine-bridge/`, matching each folder's existing style.
- Layering: `src/compiler-services/**` never imports `src/engine-bridge/**`. Only `src/engine-bridge/**` imports `@pragmatic-tech-ai/graph`. TODL depends only on `todl-runtime` (plus the engine). Upward communication is by signal only.
- Vocabulary (C1/C4) is mirrored by string value and never imported from todl-identity. The string values must be exactly the C1/C4 values.
- Research mode: retired code is deleted, with no compatibility shims, no re-exports of removed names, and no "deprecated" stubs. Update TODL callers and tests in the same task. Downstream breakage in `todl-identity-engine` and `pragmatic-server` (policy predicate surface, `PolicyScopeCompiler`, `IPrincipalFacts.Get`, `EnvironmentNodePlacement` constructor) belongs to S3/S4. They consume TODL as published `dist`, so they keep building until they bump.
- Verification gates per task: the task's test file(s), then `npm run typecheck`. Final task: full `npm test` and `npm run build`.

## Review Focus

1. **System-node attribution under load order:** in a composed environment whose app package sorts before `todl.system`, `todl.system.Owned` and `todl.system.ShareGrant` must still home to `todl.system` (in HomeModels and as the describer Owner), never to the app. Test in Task 8.
2. **A query that writes a system field directly:** a Cypher `CREATE (:hr.Employee {owner: 'x'})` (or a MERGE that creates with `owner`) must be refused even under `AccessScope.System`, not stored. A `SET e.owner` must be refused under any guarded scope. Tests in Task 9.
3. **Secured value leaking through a derive:** `derive Band = Salary;` (any derive whose expression names a secured member of the concept) would publish the secured value under an unsecured name, so it must be a compile error. Test in Task 5.
4. **Dependent-package subconcept of an owned concept:** package `hr-ext` declares `concept Contractor : hr.Employee`. `Contractor` carries `Owned` through its parent, so `hr-ext`'s `OwnedConcepts` lists it and a create of it gets an owner. Tests in Tasks 7 and 9.
5. **Upgrade swaps security with the catalog:** re-composing after `hr` v2 drops a secured flag and a role must yield a security with neither, in the same returned catalog object. No stale security may survive beside a new description. Test in Task 8.

---

### Task 1: Retire TODL tier-2 policy code

**Merge order:** waits on S4 Task 2 (retire server tier 2) being merged to pragmatic-server `master` before this task reaches TODL `main` (program ruling PR17).

Removes, per spec §8 and the index's "Retired" list: the `policy <Concept> { allow|deny … }` declaration, its lowering and node kind, the policy predicate language, `PolicyScopeCompiler` (both `FromRepository` and `FromRules`, since model policy declarations are retired too), and its exports. `IPrincipalFacts` takes its new shape here because its only reader (`PolicyScopeCompiler`) goes away.

**Files:**
- Delete: `src/compiler-services/policy/` (all four files plus `tests/policy-predicate.test.ts`)
- Delete: `src/engine-bridge/PolicyScopeCompiler.ts`, `src/engine-bridge/tests/PolicyScopeCompiler.test.ts`, `src/engine-bridge/tests/PolicyScopeCompilerFromRules.test.ts`
- Delete: `src/compiler-services/model/tests/builder-policy.test.ts`, `src/compiler-services/tests/policy-lowering.test.ts`, `src/compiler-services/tests/policy-metakind-sanity.test.ts`, `src/compiler-services/parse/tests/parse-policy.test.ts`
- Modify: `src/compiler-services/parse/parser.ts` (remove `parsePolicy`, `parseEffect`, `parseAction`, and `"policy"` in `startsDeclaration`/`parseDeclaration`)
- Modify: `src/compiler-services/parse/ast.ts` (remove `DeclKind.Policy`, `PolicyEffect`, `PolicyAction`, `PolicyRule`, `PolicyDecl`, and the `PolicyDecl` member of `Declaration`)
- Modify: `src/compiler-services/parse/loader.ts` (remove the "POLICY declarations" pass and its imports, around `:937-1005`)
- Modify: `src/compiler-services/model/builder.ts` (remove `PolicyConceptAttr`, `PolicyRulesAttr`, `definePolicy`), `src/compiler-services/model/kinds.ts` (remove `MetaKind.Policy`), `src/compiler-services/diagnostics/diagnostic.ts` (remove `PolicyUnknownConcept`, `PolicyUnknownField`, `PolicyUnsupportedRule`)
- Modify: `src/solution-services/lsp/analysis/document-symbol-provider.ts` (remove the `DeclKind.Policy` case)
- Modify: `src/engine-bridge/PrincipalFacts.ts`, `src/engine-bridge/index.ts`, `src/index.ts` (remove the "Policy predicate surface" block at `:494-511`)
- Rename and trim: `src/tests/policy-barrel-exports.test.ts` → `src/tests/query-filter-barrel-exports.test.ts` (keep only the `QueryCompareOp`/`IInstanceFilter`/`IInstanceView`/`IConnectorQueryFilterProvider`/`QueryFilter`/`QueryComparison`/`EntityHost` assertions)
- Modify: `src/engine-bridge/tests/DevLoop.test.ts` (surface list: drop `PolicyDiagnosticCode`, `PolicyScopeCompiler`, and the `IPolicyDiagnostic` fixture member), `src/engine-bridge/tests/EngineBridgeSurface.test.ts` (drop the `PolicyScopeCompiler`/`FromRules` expectations)
- Modify: `ARCHITECTURE.md` (Engine bridge bullet and `./engine` export list), `docs/ARCHITECTURE.md` (the `PolicyScopeCompiler` paragraphs near `:418` and `:459`)

**Interfaces:**
- Produces: `IPrincipalFacts` in `src/engine-bridge/PrincipalFacts.ts`:
  ```ts
  export interface IPrincipalFacts
  {
      /** The acting principal's id (a user id or the environment's system principal id, C7). */
      readonly Id: string;
      /** The principal's home business unit id (C3: owningBusinessUnit on create). */
      readonly HomeBusinessUnitId: string;
  }
  ```

- [ ] **Step 1: Write the failing tests**

In `src/compiler-services/parse/tests/parser-recovery.test.ts` add:
```ts
test("'policy' is no longer a declaration keyword", () =>
{
    const result = parse(`namespace n { concept C { } policy C { allow read when true; } }`);
    assert.ok(result.diagnostics.length > 0);
    assert.ok(!result.namespace.declarations.some((d) => (d as { kind: unknown }).kind === "policy"));
});
```
In `src/engine-bridge/tests/DevLoop.test.ts` (surface test) assert that `'PolicyScopeCompiler'` and `'PolicyDiagnosticCode'` are absent from `Object.keys(await import('../index.js'))`. In `src/tests/query-filter-barrel-exports.test.ts` assert that `'parsePolicyPredicate'`, `'PolicyPredicateCodec'`, `'PolicyNodeKind'` and `'PolicyPredicateMembers'` are absent from `Object.keys(await import('../index.js'))`.

- [ ] **Step 2: Run them to verify they fail**

Run: `npx tsx --conditions=development --test src/compiler-services/parse/tests/parser-recovery.test.ts src/engine-bridge/tests/DevLoop.test.ts src/tests/query-filter-barrel-exports.test.ts`
Expected: FAIL (the policy names are still exported, and `policy` still parses).

- [ ] **Step 3: Delete and edit per the Files list; reshape `IPrincipalFacts`**

Grep before finishing; this must return nothing under `src/`: `grep -rniE "PolicyScopeCompiler|PolicyRules|policy-predicate|MetaKind\.Policy|DeclKind\.Policy|PolicyDecl|definePolicy|IPolicyRuleSource|PolicyDiagnostic" src`. `ConnectionPolicy`, `WritePolicy` and `ConnectionRetryPolicy` are unrelated and stay. `DeclKind` is a numeric enum: confirm it is never persisted (`grep -rn "DeclKind" src --include=*.ts | grep -v parse/`) before removing a member.

- [ ] **Step 4: Run tests and typecheck**

Run: the Step 2 command, then `npm run typecheck`.
Expected: PASS, with 0 type errors.

- [ ] **Step 5: Commit**

```bash
git add -A src ARCHITECTURE.md docs/ARCHITECTURE.md
git commit -m "refactor(security)!: retire tier-2 policy declarations and PolicyScopeCompiler"
```

---

### Task 2: `todl.system.Owned` aspect and the system compile foundation

**Files:**
- Move: `src/engine-bridge/system/system.todl` → `src/compiler-services/stdlib/system/system.todl`. Move `src/engine-bridge/system/system-package.generated.ts` → `src/compiler-services/stdlib/system/system-package.generated.ts`. Update `scripts/gen-system-package.mts` (`Source`, `Target`, `Wrote`, `ImportLine` = `'../../../publish/publish.js'`), `SystemPackage.ts` and `system/tests/SystemPackage.test.ts` (source path) to match.
- Create: `src/compiler-services/security/security-names.ts`, `src/compiler-services/stdlib/compile-foundation.ts`
- Modify: `src/compiler-services/stdlib/system/system.todl` (add the aspect), `src/engine-bridge/system/SystemNames.ts` (`Model`/`Version` take `SecurityNames` values; add `Owned`, `Owner`, `OwningBusinessUnit`)
- Modify: `src/compiler-services/api.ts` (`checkAgainst` gains `foundation`), `src/publish/publish.ts` (own-set and dependency), `src/compiler-services/parse/loader.ts` (system-name redeclaration), `src/compiler-services/diagnostics/diagnostic.ts`
- Modify (seed with `CompileFoundation.Documents(FoundationKind.PreludeAndSystem)` in place of `preludeDocument()`): `src/authoring/model-draft.ts:89,110`, `src/solution-services/lsp/host/solution-graph.ts:98`, `src/solution-services/lsp/host/solution-language-service.ts:781`, `src/runtime/graph.ts:35`, `src/model-data/connector-resolution-step.ts:29`. `PackageManifestBridge.repositoryOf` stays prelude-only: a package reaches `todl.system` through its recorded dependency, like any other dependency.
- Create: `src/engine-bridge/system/SystemFirstPackageSource.ts` (extract the private `SystemFirstPackageSource` class out of `EnvironmentCatalogComposer.ts`, unchanged, and export it from `engine-bridge/index.ts` for hosts whose Domain loads packages that depend on `todl.system`)
- Test: `src/compiler-services/stdlib/tests/compile-foundation.test.ts`, `src/engine-bridge/system/tests/SystemPackage.test.ts`

**Interfaces:**
- Produces, in `security-names.ts`:
  ```ts
  export class SecurityNames
  {
      public static readonly SystemModel = 'todl.system';
      public static readonly SystemVersion = '1.0.0';
      public static readonly OwnedAspect = 'todl.system.Owned';
      public static readonly Owner = 'owner';
      public static readonly OwningBusinessUnit = 'owningBusinessUnit';
      public static readonly SystemFields: ReadonlySet<string>;   // { Owner, OwningBusinessUnit }
      public static IsSystemField(member: string): boolean;
  }
  ```
- Produces, in `compile-foundation.ts`:
  ```ts
  export enum FoundationKind { PreludeAndSystem = 'prelude-and-system', PreludeOnly = 'prelude-only' }
  export class CompileFoundation
  {
      public static Documents(kind: FoundationKind): readonly TodlDocument[];   // [prelude] or [prelude, system document]
      public static SystemIds(): ReadonlySet<string>;                         // node ids of the system document
  }
  ```
- Produces: `checkAgainst(bases, sources, idGenerator?, policy?, foundation: FoundationKind = FoundationKind.PreludeAndSystem)`. `compilePackage` passes `FoundationKind.PreludeOnly` iff `identity.id === SecurityNames.SystemModel`.
- Produces: `DiagnosticCode.SecuritySystemNameRedeclared = "security.system-name-redeclared"` (Error).
- Aspect added to `system.todl`. The fields are optional because seed instances and pre-aspect records carry none until placed or backfilled; the engine bridge, not the package, maintains them:
  ```
  aspect Owned
  {
      owner              : string?;
      owningBusinessUnit : string?;
  }
  ```

- [ ] **Step 1: Write the failing tests**

`compile-foundation.test.ts`:
```ts
test("a package concept takes todl.system.Owned and compiles clean", () =>
{
    const out = compilePackage([], [{ uri: "hr.todl", text: Fx.Hr }], { id: "hr", version: "1.0.0" });
    assert.ok(out.ok, JSON.stringify(out.errors));
    assert.ok(out.package!.document.dependencies!.some((d) => d.id === "todl.system" && d.version === "1.0.0"));
    assert.ok(!out.package!.document.nodes.some((n) => n.id.startsWith("todl.system.")));   // system nodes are not own
});
test("a package that does not use todl.system records no system dependency", () => { /* Fx.Plain → dependencies undefined */ });
test("redeclaring todl.system.Owned is an error", () =>
{
    const { diagnostics } = checkAgainst([], [{ uri: "x.todl", text: "namespace todl.system { aspect Owned { owner : string?; } }" }]);
    assert.ok(diagnostics.some((d) => d.code === DiagnosticCode.SecuritySystemNameRedeclared && d.severity === Severity.Error));
});
test("the system package itself compiles with the prelude-only foundation", () => { /* compilePackage(system.todl, todl.system@1.0.0).ok */ });
```
with `Fx.Hr = 'namespace hr { concept Employee : todl.system.Owned { Name : string; } }'`.
In `SystemPackage.test.ts` add `test('describes the Owned aspect with two string properties')`: find the `todl.system.Owned` definition in `SystemFx.Definitions(...)` and assert its members are `owner` and `owningBusinessUnit`, both `MemberKind.Property` with `ValueType.String`. The existing `generated system package is current` test must stay green after `npm run gen:system-package`.

- [ ] **Step 2: Run them to verify they fail**

Run: `npx tsx --conditions=development --test src/compiler-services/stdlib/tests/compile-foundation.test.ts src/engine-bridge/system/tests/SystemPackage.test.ts`
Expected: FAIL (`todl.system.Owned` is unresolved, and `CompileFoundation` does not exist).

- [ ] **Step 3: Implement**

`compilePackage` builds its own-set from `CompileFoundation.Documents(kind)` plus `bases`. When an own node has an edge to an id in `CompileFoundation.SystemIds()`, it appends `{ id: SecurityNames.SystemModel, version: SecurityNames.SystemVersion }` to `document.dependencies` (deduplicated). In `loadInto`'s reserved-name filter, a named ontology declaration whose qualified id is already present in the seeded model and lies in `CompileFoundation.SystemIds()` is dropped with `SecuritySystemNameRedeclared`. Under `PreludeOnly` the system ids are not seeded, so `system.todl` compiles. Run `npm run gen:system-package` and commit the regenerated file.

- [ ] **Step 4: Run tests and typecheck**

Run: the Step 2 command, `npx tsx --conditions=development --test src/engine-bridge/environment/tests/EnvironmentCatalogComposer.test.ts src/engine-bridge/tests/SavedModelCompiler.test.ts`, then `npm run typecheck`.
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -A src scripts
git commit -m "feat(security): todl.system.Owned aspect as an implicit compile foundation"
```

---

### Task 3: Security vocabulary, compiled types, and declaration syntax

**Files:**
- Create: `src/compiler-services/security/security-terms.ts`, `src/compiler-services/security/package-security.ts`
- Modify: `src/compiler-services/parse/ast.ts`, `src/compiler-services/parse/parser.ts`, `src/solution-services/lsp/analysis/document-symbol-provider.ts`, `src/index.ts` (root export of the vocabulary and the C2 interfaces)
- Test: `src/compiler-services/security/tests/security-terms.test.ts`, `src/compiler-services/parse/tests/parse-security.test.ts`

**Interfaces:**
- Produces, in `security-terms.ts` (C1/C4 values verbatim):
  ```ts
  export enum SecurityAction { Create = 'create', Read = 'read', Update = 'update', Delete = 'delete', Append = 'append', AppendTo = 'appendTo', Assign = 'assign', Share = 'share', Invoke = 'invoke' }
  export enum SecurityDepth { None = 'none', User = 'user', BusinessUnit = 'businessUnit', BusinessUnitAndChildren = 'businessUnitAndChildren', Organization = 'organization' }
  export enum BaseRoleName { SystemAdministrator = 'SystemAdministrator', BasicUser = 'BasicUser', Reader = 'Reader' }
  export enum FieldProfileRight { Read = 'read', Update = 'update', Create = 'create' }
  export class SecurityTerms
  {
      public static ActionOf(text: string): SecurityAction | undefined;
      public static DepthOf(text: string): SecurityDepth | undefined;
      public static BaseRoleOf(text: string): BaseRoleName | undefined;   // exact, case-sensitive
      public static RightOf(text: string): FieldProfileRight | undefined;
  }
  ```
  The class is named `SecurityTerms` so it does not collide with S3's `SecurityVocabulary` mapping class.
- Produces, in `package-security.ts`: exactly the C2 interfaces `IPackageSecurity`, `IPackageRole`, `ISecurityPrivilege`, `ISecuredField`, `IFieldProfile`, `IFieldProfileEntry`, plus `PackageSecurity.Empty: IPackageSecurity` (a frozen value with all arrays empty) on a `PackageSecurity` class. Program ruling PR4 extends C2 with the package's reified edge concepts:
  ```ts
  export interface IEdgeConcept { readonly Concept: string; readonly From: string; readonly To: string; }   // From/To = the operator's endpoint member names
  export interface IPackageSecurity
  {
      // … the five C2 members …
      readonly EdgeConcepts: readonly IEdgeConcept[];
  }
  ```
- Produces, in `ast.ts`: `DeclKind.Role`, `DeclKind.Contribution`, `DeclKind.Profile` (appended), and `FieldDecl.secured?: boolean` (with `securedSpan?: SourceSpan`):
  ```ts
  export interface PrivilegeEntry { action: string; depth: string; span: SourceSpan; actionSpan?: SourceSpan; depthSpan?: SourceSpan; }
  export interface ConceptPrivileges { concept: string; entries: PrivilegeEntry[]; span: SourceSpan; conceptSpan?: SourceSpan; }
  export interface RoleDecl { kind: DeclKind.Role; name: string; concepts: ConceptPrivileges[]; span: SourceSpan; nameSpan?: SourceSpan; }
  export interface ContributionDecl { kind: DeclKind.Contribution; baseRole: string; concepts: ConceptPrivileges[]; span: SourceSpan; baseRoleSpan?: SourceSpan; }
  export interface ProfileEntry { concept: string; field: string; rights: string[]; span: SourceSpan; fieldSpan?: SourceSpan; }
  export interface ProfileDecl { kind: DeclKind.Profile; name: string; entries: ProfileEntry[]; span: SourceSpan; nameSpan?: SourceSpan; }
  ```
  Actions, depths and rights are kept as authored text. The loader (Task 4/5) validates them so that an unknown word produces a spanned semantic diagnostic, not a parse failure.
- Syntax (namespace scope, same shape as `identity`/`match`/`merge`). The keyword applies only when it is followed by an identifier; `secured` applies only when it is followed by an identifier, so a field named `secured : string;` still parses:
  ```
  namespace projects
  {
      concept Project : todl.system.Owned { name : string; secured budget : number?; }
      role ProjectManager
      {
          Project { read = businessUnitAndChildren; update = businessUnit; }
      }
      contribute BasicUser
      {
          Project { read = user; }
      }
      profile Finance
      {
          Project.budget : read, update;
      }
  }
  ```

- [ ] **Step 1: Write the failing tests**

`security-terms.test.ts`:
```ts
test("action values are the C1 PrivilegeAction strings", () =>
    assert.deepEqual(Object.values(SecurityAction), ["create", "read", "update", "delete", "append", "appendTo", "assign", "share", "invoke"]));
test("depth values are the C1 AccessLevel strings", () =>
    assert.deepEqual(Object.values(SecurityDepth), ["none", "user", "businessUnit", "businessUnitAndChildren", "organization"]));
test("base role values are the C4 names", () => assert.deepEqual(Object.values(BaseRoleName), ["SystemAdministrator", "BasicUser", "Reader"]));
test("BaseRoleOf is exact", () => { assert.equal(SecurityTerms.BaseRoleOf("BasicUser"), BaseRoleName.BasicUser); assert.equal(SecurityTerms.BaseRoleOf("basicuser"), undefined); });
```
`parse-security.test.ts`: parsing the sample above yields one `RoleDecl` (`name "ProjectManager"`, concept `Project`, entries `[{action:"read",depth:"businessUnitAndChildren"},{action:"update",depth:"businessUnit"}]`), one `ContributionDecl` (`baseRole "BasicUser"`), one `ProfileDecl` (entry `{concept:"Project", field:"budget", rights:["read","update"]}`), and the field `budget` has `secured === true`, all with no diagnostics. Also add: `test("a field named secured still parses")` with `concept C { secured : string; }` giving a field `secured` whose `secured` flag is falsy; `test("qualified concept in a role")` with `role R { acme.core.Thing { read = organization; } }` giving `concept === "acme.core.Thing"`; and `test("document symbols list roles, contributions and profiles")` in the LSP symbol-provider test file.

- [ ] **Step 2: Run them to verify they fail**

Run: `npx tsx --conditions=development --test src/compiler-services/security/tests/security-terms.test.ts src/compiler-services/parse/tests/parse-security.test.ts`
Expected: FAIL (module and declaration kinds not found).

- [ ] **Step 3: Implement** `parseRole`, `parseContribution`, `parseProfile` and the `secured` modifier in `parseSchemaMember`

Each new keyword is a `private static readonly` constant on `Parser` (as `AspectKeyword` already is). Add the keywords to `startsDeclaration`. Profile rights are a comma-separated identifier list ending at `;`. `contribute` takes a bare identifier (base role names are unqualified).

- [ ] **Step 4: Run tests and typecheck**

Run: the Step 2 command plus `npx tsx --conditions=development --test src/compiler-services/parse/tests/*.test.ts`, then `npm run typecheck`.
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -A src
git commit -m "feat(security): vocabulary, IPackageSecurity types and role/contribute/profile/secured syntax"
```

---

### Task 4: Lower and validate roles and base-role contributions

**Files:**
- Create: `src/compiler-services/security/security-lowering.ts`, `src/compiler-services/security/security-validator.ts`, `src/compiler-services/security/privilege-rules.ts`, `src/compiler-services/security/reified-operators.ts`
- Modify: `src/compiler-services/model/kinds.ts` (`Role = "role"`, `RoleContribution = "role-contribution"`, `FieldProfile = "field-profile"`), `src/compiler-services/model/builder.ts`, `src/compiler-services/parse/loader.ts` (call `SecurityLowering` after the identity/match/merge passes, where the policy pass used to run), `src/compiler-services/api.ts` (`checkAgainst` appends `new SecurityValidator(model, seededIds).Validate()`, where `seededIds` = the ids of the merged foundation and bases, captured before `loadInto`), `src/compiler-services/diagnostics/diagnostic.ts`
- Test: `src/compiler-services/security/tests/role-lowering.test.ts`

**Interfaces:**
- Consumes: Task 3 AST, `SecurityTerms`, `BaseRoleName`; Task 2 `SecurityNames.OwnedAspect`.
- Produces, on `Builder`: `RoleNameAttr = "name"`, `RolePrivilegesAttr = "privileges"`, `ContributionRoleAttr = "role"`, `ProfileNameAttr = "name"`, `ProfileFieldsAttr = "fields"`, plus:
  ```ts
  DefineRole(id: NodeId, name: string, privilegesJson: string): this                  // MetaKind.Role
  DefineRoleContribution(id: NodeId, baseRole: BaseRoleName, privilegesJson: string): this   // MetaKind.RoleContribution
  DefineFieldProfile(id: NodeId, name: string, fieldsJson: string): this              // MetaKind.FieldProfile (Task 5)
  ```
  Node ids: `${ns}.${name}@role`, `${ns}.${baseRole}@contribution`, `${ns}.${name}@profile`. Several `contribute X` blocks in one namespace merge into one node, in source order. `privilegesJson` is `JSON.stringify(ISecurityPrivilege[])` with resolved, qualified concept ids. `fieldsJson` is `JSON.stringify(IFieldProfileEntry[])`.
- Produces: `class SecurityLowering { constructor(model: Repository, resolver: Resolver, diagnostics: Diagnostic[]); Lower(units: readonly ISecurityUnit[]): readonly ISecurityHome[] }`, where `ISecurityUnit { ns; imports; uri; decl: RoleDecl | ContributionDecl | ProfileDecl }` and `ISecurityHome { Id: string; Uri: string }` (the loader records each with `recordHome`).
- Produces: `class SecurityValidator { constructor(model: Repository, seededIds: ReadonlySet<string>); Validate(): Diagnostic[] }`. It composes `PrivilegeRules`, `FieldSecurityRules` (Task 5) and `SystemFieldRules` (Task 6), each with `Validate(sink: Diagnostic[]): void`. An "own concept" is a `MetaKind.Concept` node whose id is not in `seededIds`.
- Produces (all `Severity.Error`) the following `DiagnosticCode` members:

  | Member | Code | Rule |
  |---|---|---|
  | `SecurityUnknownConcept` | `security.unknown-concept` | concept does not resolve to a concept |
  | `SecurityForeignConcept` | `security.foreign-concept` | concept is a dependency's, the prelude's or `todl.system`'s (spec §4.3 package scope) |
  | `SecurityUnknownAction` | `security.unknown-action` | action word is not a `SecurityAction` |
  | `SecurityUnknownDepth` | `security.unknown-depth` | depth word is not a `SecurityDepth` |
  | `SecurityUnknownBaseRole` | `security.unknown-base-role` | `contribute` target is not a `BaseRoleName` (case-sensitive) |
  | `SecuritySystemAdministratorContribution` | `security.system-administrator-contribution` | contributing to `SystemAdministrator` (it bypasses all checks, so a contribution is meaningless) |
  | `SecurityRoleShadowsBaseRole` | `security.role-shadows-base-role` | `role BasicUser { … }` |
  | `SecurityDuplicateRole` | `security.duplicate-role` | two roles with one local name in one compile, in any namespaces |
  | `SecurityDuplicatePrivilege` | `security.duplicate-privilege` | one (role or contribution, concept, action) written twice |
  | `SecurityDepthRequiresOwnership` | `security.depth-requires-ownership` | depth `user`/`businessUnit`/`businessUnitAndChildren` on a concept that does not carry `Owned` (spec §4.4: organisation-owned concepts take Org or None only) |
  | `SecurityEdgeConceptPrivilege` | `security.edge-concept-privilege` | privilege on a concept targeted by a reified `operator` (`EdgeKind.Targets` from a `MetaKind.Operator` node with a `from` attr; spec §5: edges carry no privileges) |

  | `SecurityEdgeEndpointsConflict` | `security.edge-endpoints-conflict` | two reified operators target one concept with different `from`/`to` members (an edge concept has one endpoint pair; PR4) |

  "Carries `Owned`" means `model.IsA(concept, SecurityNames.OwnedAspect)`.
- Produces, in `reified-operators.ts`, the one detection of a reified edge concept, shared by `PrivilegeRules` (`security.edge-concept-privilege`, `security.edge-endpoints-conflict`), `SystemFieldRules` (Task 6, `security.owned-edge-concept`) and `PackageSecurityCompiler` (Task 7, `EdgeConcepts`):
  ```ts
  export class ReifiedOperators
  {
      /** Every concept targeted (EdgeKind.Targets) by a MetaKind.Operator node that has a `from` attr, with that node's `from`/`to` attrs; sorted by Concept. */
      public static Of(model: Repository): readonly IEdgeConcept[];
      public static IsEdgeConcept(model: Repository, concept: string): boolean;
  }
  ```

- [ ] **Step 1: Write the failing tests**

`role-lowering.test.ts` uses one fixture class `RoleFx`. Its `Base` is a compiled dependency `crm` with `concept Account`; its own sources hold an owned `projects.Project`, an unowned `projects.Setting`, and `operator --> : projects.Link (from, to)`. Tests:
```ts
test("a role lowers to one role node with qualified privileges", () =>
{
    const { model, diagnostics } = RoleFx.Check(`role ProjectManager { Project { read = businessUnitAndChildren; update = businessUnit; } }`);
    assert.deepEqual(RoleFx.Errors(diagnostics), []);
    const node = model.resolve("projects.ProjectManager@role")!;
    assert.equal(node.metaKind, MetaKind.Role);
    assert.deepEqual(JSON.parse(String(node.attrs.get(Builder.RolePrivilegesAttr))), [
        { Concept: "projects.Project", Action: "read", Depth: "businessUnitAndChildren" },
        { Concept: "projects.Project", Action: "update", Depth: "businessUnit" }]);
});
test("two contribute BasicUser blocks merge into one node", ...);
test("privilege on a dependency's concept is security.foreign-concept", ...);       // crm.Account
test("privilege on todl.system.ShareGrant is security.foreign-concept", ...);
test("contribute basicuser is security.unknown-base-role", ...);
test("contribute SystemAdministrator is rejected", ...);
test("role BasicUser is security.role-shadows-base-role", ...);
test("unknown action 'write' is security.unknown-action", ...);                     // the spec's "write" is update (C1)
test("unknown depth 'team' is security.unknown-depth", ...);
test("user depth on unowned Setting is security.depth-requires-ownership", ...);
test("organization depth on unowned Setting is accepted", ...);
test("privilege on reified edge concept Link is security.edge-concept-privilege", ...);
test("two operators binding Link to different members is security.edge-endpoints-conflict", ...);   // operator --> : Link (from, to); operator <-- : Link (to, from)
test("one action twice on one concept is security.duplicate-privilege", ...);
test("one role name in two namespaces is security.duplicate-role", ...);
```
Each rejection test asserts exactly one diagnostic with that code and `Severity.Error`, and a span on the offending word (`actionSpan`/`depthSpan`/`conceptSpan`/`baseRoleSpan`/`nameSpan`).

- [ ] **Step 2: Run it to verify it fails**

Run: `npx tsx --conditions=development --test src/compiler-services/security/tests/role-lowering.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement `SecurityLowering` (roles and contributions), `PrivilegeRules`, the Builder methods and the codes**

Messages are `private static readonly` templates on the class that reports them. Unknown and foreign concepts are reported in lowering, where the reference is resolved, and the entry is dropped. The ownership and edge rules run in `PrivilegeRules` over the lowered nodes, so they also see aspects that arrive through bases.

- [ ] **Step 4: Run tests and typecheck**

Run: the Step 2 command, `npx tsx --conditions=development --test src/compiler-services/parse/tests/*.test.ts src/compiler-services/model/tests/*.test.ts`, then `npm run typecheck`.
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -A src
git commit -m "feat(security): lower and validate package roles and base-role contributions"
```

---

### Task 5: Lower and validate secured fields and field profiles

**Files:**
- Create: `src/compiler-services/security/field-security-rules.ts`
- Modify: `src/compiler-services/model/graph.ts` (`FieldDecl.secured?: boolean`), `src/compiler-services/model/builder.ts` (`addField(concept, name, type, cardinality = Cardinality.One, secured = false)`; the flag is written only when true, so existing documents and goldens stay byte-identical), `src/compiler-services/parse/loader.ts` (pass `field.secured` in the concept/aspect member pass at `:735-738`), `src/compiler-services/security/security-lowering.ts` (profiles), `src/compiler-services/diagnostics/diagnostic.ts`
- Test: `src/compiler-services/security/tests/field-security.test.ts`

**Interfaces:**
- Consumes: Task 4 `SecurityValidator`/`SecurityLowering`, `Builder.DefineFieldProfile`.
- Produces (all Errors) these `DiagnosticCode` members: `SecuritySecuredOnAspect` (`security.secured-on-aspect`: `secured` in an aspect body); `SecuritySecuredIdentityKey` (`security.secured-identity-key`: `identity C key f` where `f` is secured on `C` or an ancestor); `SecuritySecuredMatchMember` (`security.secured-match-member`: a `match` rule whose normalized field set contains a secured field); `SecuritySecuredInDerive` (`security.secured-in-derive`: a `derive` expression of a concept naming a secured member of that concept, detected by lexing the stored expression text with `Lexer` and matching identifier tokens); `SecurityDuplicateProfile` (`security.duplicate-profile`); `SecurityProfileUnknownField` (`security.profile-unknown-field`: the concept has no such declared field); `SecurityProfileFieldNotSecured` (`security.profile-field-not-secured`); `SecurityUnknownProfileRight` (`security.unknown-profile-right`); `SecurityWriteWithoutRead` (`security.write-without-read`: a profile entry granting `update` or `create` without `read`; program ruling PR8, because the engine refuses every write to a member hidden from the writer). Profile concepts reuse `SecurityUnknownConcept`/`SecurityForeignConcept`.
- TODL has no unique-index declaration today. Spec §5's "secured fields cannot be declared unique or used as identity keys" is therefore enforced over the identity keys TODL has: `identity … key` and `match` rules. Any future unique declaration must call `FieldSecurityRules.IsSecured(concept, member): boolean` (public).
- A profile entry targets the concept that declares the secured field. An entry naming a subconcept of it is resolved to the declaring concept through `effectiveSchema` and stored with the declaring concept's id, so `ISecuredField` and `IFieldProfileEntry` always agree on `Concept`.

- [ ] **Step 1: Write the failing tests**

`field-security.test.ts` (fixture `FieldFx`; own `hr.Employee : todl.system.Owned { Name : string; secured Salary : number?; secured NationalId : string?; Band : string?; }`):
```ts
test("secured flag survives compile and JSON round-trip", () =>
{
    const doc = FieldFx.Compile().package!.document;
    const employee = doc.nodes.find((n) => n.id === "hr.Employee")!;
    assert.equal(employee.fields.find((f) => f.name === "Salary")!.secured, true);
    assert.equal(employee.fields.find((f) => f.name === "Name")!.secured, undefined);
});
test("profile lowers to one field-profile node", ...);   // Compensation { Employee.Salary : read, update; } → [{Concept:"hr.Employee",Field:"Salary",Read:true,Update:true,Create:false}]
test("secured in an aspect body is security.secured-on-aspect", ...);
test("identity Employee key NationalId is security.secured-identity-key", ...);
test("match Employee { same when a.NationalId == b.NationalId; } is security.secured-match-member", ...);
test("derive over a secured member is security.secured-in-derive", ...);   // aspect Banded { Band2 : string?; } … derive Band2 = Salary;
test("profile on unsecured Name is security.profile-field-not-secured", ...);
test("profile on missing field is security.profile-unknown-field", ...);
test("profile right 'write' is security.unknown-profile-right", ...);
test("profile on a dependency concept's field is security.foreign-concept", ...);
test("two profiles named Compensation is security.duplicate-profile", ...);
test("profile Employee.Salary : update; is security.write-without-read", () =>   // PR8
{
    const { diagnostics } = FieldFx.Check(`profile Payroll { Employee.Salary : update; }`);
    assert.deepEqual(FieldFx.Errors(diagnostics).map((d) => d.code), [DiagnosticCode.SecurityWriteWithoutRead]);
    assert.ok(FieldFx.Errors(diagnostics)[0].span);
});
test("profile Employee.Salary : create; is security.write-without-read", ...);
test("profile Employee.Salary : read, create; is accepted", ...);
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx tsx --conditions=development --test src/compiler-services/security/tests/field-security.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement** the profile lowering, `FieldSecurityRules`, the `secured` flag plumbing and the codes

- [ ] **Step 4: Run tests and typecheck**

Run: the Step 2 command, `npx tsx --conditions=development --test "src/compiler-services/**/*.test.ts"`, then `npm run typecheck`.
Expected: PASS (existing goldens unchanged).

- [ ] **Step 5: Commit**

```bash
git add -A src
git commit -m "feat(security): secured fields and field profiles with identity/derive leak checks"
```

---

### Task 6: System-field rules for owned concepts

**Files:**
- Create: `src/compiler-services/security/system-field-rules.ts`
- Modify: `src/compiler-services/security/security-validator.ts`, `src/compiler-services/diagnostics/diagnostic.ts`
- Test: `src/compiler-services/security/tests/system-field-rules.test.ts`

**Interfaces:**
- Consumes: `SecurityNames`, `ReifiedOperators` (Task 4), `Repository.IsA`, `Repository.DerivesOf`, `Repository.CarriersOf`, the member-target nodes (`MetaKind.MemberTarget`, `Builder.MemberTargetNameAttr`), the population nodes (`MetaKind.Population`, `Builder.BindingConceptAttr`), and the operator `Targets` edges.
- Produces (all Errors), checked only over own nodes. "Carries Owned" means `IsA(type, SecurityNames.OwnedAspect)`. The codes:
  - `SecuritySystemFieldDeclared` (`security.system-field-declared`): an own concept or aspect that carries `Owned` declares a field or relationship named `owner`/`owningBusinessUnit`. This covers redeclare, retype in a subconcept, and shadow through another included aspect. It is reported beside the existing `MemberRedeclared`/`MemberCollision`, not instead of them.
  - `SecuritySystemFieldDerived` (`security.system-field-derived`): a `derive owner = …;` or `derive owningBusinessUnit = …;`.
  - `SecuritySystemFieldAnnotated` (`security.system-field-annotated`): a `member owner { annotate … }` block. The package may not shape system fields.
  - `SecuritySystemFieldWritten` (`security.system-field-written`): any own instance, class or inline object whose type carries `Owned` and assigns `owner`/`owningBusinessUnit` (an attr or a `Relationship` edge via that name, the same detection as `TypeModelValidator.CheckDerivedAssignments`). This is the spec's "write them in a mutation" for TODL source. Runtime writes are Task 9.
  - `SecurityOwnedEdgeConcept` (`security.owned-edge-concept`): a concept that carries `Owned` and is targeted by a reified operator (`ReifiedOperators.IsEdgeConcept`, Task 4).
  - `SecurityExternalConcept` (`security.external-concept`): a `populate C` in this compile where `C` carries `Owned` or has a secured field. Connector data is outside the model (spec §6). The composition-time counterpart for populations in other packages is Task 8.
- The language has no rename construct, so "rename" is covered by `SecuritySystemFieldDeclared`.

- [ ] **Step 1: Write the failing tests**

`system-field-rules.test.ts`, one test per code, each asserting exactly that code (Error) and a non-null span. Fixtures:
```ts
"concept E : todl.system.Owned { owner : string?; }"                                  // system-field-declared (+ type.member-redeclared)
"concept P : todl.system.Owned { } concept C : P { owningBusinessUnit : integer?; }"  // system-field-declared on C (retype)
"aspect Mine { owner : string?; } concept E : todl.system.Owned, Mine { }"            // system-field-declared (shadow; + type.member-collision)
"concept E : todl.system.Owned { derive owner = \"x\"; }"                             // system-field-derived
"concept E : todl.system.Owned { member owner { annotate @label(text = \"x\"); } }"   // system-field-annotated (use the prelude annotation the member-annotation tests use)
"model M : n { E e1 { owner = \"u1\"; } }"                                            // system-field-written
"concept L : todl.system.Owned { from : X; to : X; } operator ==> : L (from, to);"   // owned-edge-concept
"datasource crm { kind = sql; connection = \"c\"; } model M : n { connect crm; populate E; }"  // external-concept
```
Plus `test("an unowned concept may declare its own field named owner")` (no security diagnostic), and `test("a seed instance of an owned concept without system fields compiles clean")`.

- [ ] **Step 2: Run it to verify it fails**

Run: `npx tsx --conditions=development --test src/compiler-services/security/tests/system-field-rules.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement `SystemFieldRules.Validate(sink)`** and register it in `SecurityValidator`

- [ ] **Step 4: Run tests and typecheck**

Run: the Step 2 command, `npx tsx --conditions=development --test "src/compiler-services/**/*.test.ts"`, then `npm run typecheck`.
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -A src
git commit -m "feat(security): reject packages that shape or write system ownership fields"
```

---

### Task 7: Compiled `IPackageSecurity` on the package

**Files:**
- Create: `src/compiler-services/security/package-security-compiler.ts`
- Modify: `src/publish/publish.ts` (`CompiledPackage.Security`, `PackageDocument.security?`), `src/index.ts` (export `PackageSecurityCompiler`)
- Test: `src/compiler-services/security/tests/package-security-compiler.test.ts`

**Interfaces:**
- Consumes: Tasks 3–6 nodes and attrs; `ReifiedOperators` (Task 4).
- Produces:
  ```ts
  export class PackageSecurityCompiler
  {
      /** The package's security from a clean compile: own nodes only, names qualified by `packageId`. */
      public static Compile(model: Repository, ownIds: ReadonlySet<string>, packageId: string): IPackageSecurity;
  }
  ```
  Rules:
  - `OwnedConcepts`: every own `MetaKind.Concept` that carries `Owned`, directly or through a parent or aspect (effective, including subconcepts of a dependency's owned concept), sorted.
  - `Roles`: one per `MetaKind.Role` node, with `Name = ${packageId}.${localName}`.
  - `BaseRoleContributions`: role-contribution nodes merged per base role across namespaces, with `Name = BaseRoleName` (unqualified, per C4).
  - `SecuredFields`: own concepts' fields with `secured`.
  - `FieldProfiles`: `Name = ${packageId}.${localName}`.
  - `EdgeConcepts` (PR4): `ReifiedOperators.Of(model)` restricted to own concepts, one entry per concept with the operator's `from`/`to` member names. Task 4 already rejected a concept with two different endpoint pairs, and an edge concept takes neither `Owned` nor privileges (Tasks 4 and 6).
  - Every array is sorted (by Name, then Concept, then Action/Field) so that the persisted JSON is deterministic.
  - Clarification of C2: `OwnedConcepts` is the *effective* carrier set, because placement (Task 9) and S3 need every concept whose records get system fields.
- Produces: `CompiledPackage.Security: IPackageSecurity` and the persisted `PackageDocument.security?: IPackageSecurity`. The field is set only when the security is non-empty, so documents of packages without security stay byte-identical.

- [ ] **Step 1: Write the failing test**

```ts
test("projects compiles to qualified roles, contributions, secured fields and profiles", () =>
{
    const out = compilePackage([], [{ uri: "p.todl", text: SecFx.Projects }], { id: "projects", version: "1.0.0" });
    assert.ok(out.ok, JSON.stringify(out.errors));
    const s = out.package!.Security;
    assert.deepEqual(s.OwnedConcepts, ["projects.Project", "projects.Task"]);
    assert.deepEqual(s.Roles.map((r) => r.Name), ["projects.ProjectManager", "projects.ProjectMember"]);
    assert.deepEqual(s.BaseRoleContributions.map((r) => r.Name), ["BasicUser"]);
    assert.deepEqual(s.SecuredFields, [{ Concept: "projects.Project", Field: "budget" }]);
    assert.deepEqual(s.FieldProfiles[0], { Name: "projects.Finance", Fields: [{ Concept: "projects.Project", Field: "budget", Read: true, Update: true, Create: false }] });
    assert.deepEqual(out.package!.document.security, s);
});
test("a package without security has PackageSecurity.Empty and no document.security", ...);
test("a dependent package's subconcept of an owned concept is in its OwnedConcepts", ...);   // hr-ext: concept Contractor : hr.Employee → ["hr-ext.Contractor"] (Review Focus 4)
test("reified edge concepts are listed with their endpoint members", () =>   // PR4
{
    const out = compilePackage([], [{ uri: "p.todl", text: SecFx.ProjectsWithAssignment }], { id: "projects", version: "1.0.0" });
    assert.ok(out.ok, JSON.stringify(out.errors));
    // concept Assignment { from : Person; to : Project; role : string?; } operator ==> : Assignment (from, to);
    assert.deepEqual(out.package!.Security.EdgeConcepts, [{ Concept: "projects.Assignment", From: "from", To: "to" }]);
    assert.ok(!out.package!.Security.OwnedConcepts.includes("projects.Assignment"));
});
test("a non-reified operator lists no edge concept", ...);   // operator ~> : relates;  (no from attr) → EdgeConcepts []
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx tsx --conditions=development --test src/compiler-services/security/tests/package-security-compiler.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement** `PackageSecurityCompiler.Compile` and call it in `compilePackage` after the own-set is computed

- [ ] **Step 4: Run tests and typecheck**

Run: the Step 2 command, `npx tsx --conditions=development --test "src/publish/**/*.test.ts" "src/solution-services/todl-build-system/**/*.test.ts"`, then `npm run typecheck`.
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -A src
git commit -m "feat(security): compile IPackageSecurity onto the package and its document"
```

---

### Task 8: `IEnvironmentSecurity` composed and swapped with the catalog

**Files:**
- Create: `src/engine-bridge/environment/EnvironmentSecurity.ts`
- Modify: `src/engine-bridge/environment/EnvironmentCatalogComposer.ts` (`IEnvironmentCatalog.Security`), `src/engine-bridge/environment/EnvironmentCatalogError.ts` (append codes), `src/engine-bridge/index.ts`
- Test: `src/engine-bridge/environment/tests/EnvironmentSecurity.test.ts`

**Interfaces:**
- Consumes: `PackageDocument.security` (Task 7), the composer's `documents`, `HomeModels`, and the described external bindings (`Described(...)`).
- Produces:
  ```ts
  export interface IEnvironmentSecurity
  {
      readonly Packages: ReadonlyMap<string, IPackageSecurity>;   // C2: package model id → its security (todl.system → PackageSecurity.Empty)
      readonly EdgeConcepts: readonly IEdgeConcept[];             // PR4: union of every package's EdgeConcepts, sorted by Concept
  }
  export class EnvironmentSecurity implements IEnvironmentSecurity
  {
      public readonly Packages: ReadonlyMap<string, IPackageSecurity>;
      public readonly EdgeConcepts: readonly IEdgeConcept[];
      public static Compose(documents: ReadonlyMap<string, PackageDocument>, homeModels: ReadonlyMap<string, string>,
          external: readonly IExternalBinding[], deliveries: ReadonlyMap<string, readonly string[]>): EnvironmentSecurity;
      /** Union of every package's OwnedConcepts. */
      public OwnedConcepts(): ReadonlySet<string>;
  }
  ```
  `IEnvironmentCatalog` gains `readonly Security: EnvironmentSecurity`, built inside `Compose` from the same `documents`. Because security lives on the catalog object, a host that swaps the catalog swaps the security in the same step (spec §9.4).
- Produces: `EnvironmentCatalogErrorCode.ForeignSecurityConcept` (a package's security names a concept that `HomeModels` homes elsewhere: a hand-made or stale document) and `EnvironmentCatalogErrorCode.SecuredExternalConcept` (an owned concept, or one with a secured field, is bound to an external connector by any package; spec §6). Both are appended, and messages are constants.

- [ ] **Step 1: Write the failing tests**

`EnvironmentSecurity.test.ts` reuses `ComposeFx`-style storage (compile with `compilePackage`, persist via `StoragePackageSource` over `FakeStorage`):
```ts
test("catalog carries every delivered package's security, keyed by model", async () =>
{
    const catalog = await SecFx.Compose([SecFx.Hr, SecFx.Projects]);
    assert.deepEqual([...catalog.Security.Packages.keys()].sort(), ["hr", "projects", "todl.system"]);
    assert.deepEqual(catalog.Security.Packages.get("hr")!.SecuredFields, [{ Concept: "hr.Employee", Field: "NationalId" }, { Concept: "hr.Employee", Field: "Salary" }]);
    assert.ok(catalog.Security.OwnedConcepts().has("projects.Task"));
});
test("system concepts home to todl.system even when an app sorts first", async () =>   // Review Focus 1; app model id "aaa"
{
    const catalog = await SecFx.Compose([SecFx.Named("aaa", SecFx.HrSource)]);
    assert.equal(catalog.HomeModels.get("todl.system.ShareGrant"), "todl.system");
    assert.ok(!catalog.HomeModels.has("todl.system.Owned") || catalog.HomeModels.get("todl.system.Owned") === "todl.system");
    assert.ok(catalog.Description.Definitions.some((d) => d.Name === "todl.system.Owned"));
    // A ShareGrant created through EnvironmentNodePlacement is owned by todl.system, not "aaa".
});
test("re-composing after an upgrade replaces the security with the catalog", async () =>   // Review Focus 5
{
    const v1 = await SecFx.Compose([SecFx.Hr]);
    const v2 = await SecFx.Compose([SecFx.HrV2WithoutSalaryFlagAndRole]);
    assert.ok(v1.Security.Packages.get("hr")!.SecuredFields.some((f) => f.Field === "Salary"));
    assert.ok(!v2.Security.Packages.get("hr")!.SecuredFields.some((f) => f.Field === "Salary"));
    assert.deepEqual(v2.Security.Packages.get("hr")!.Roles, []);
});
test("environment security unions every package's edge concepts", async () =>   // PR4
{
    const catalog = await SecFx.Compose([SecFx.Hr, SecFx.ProjectsWithAssignment]);
    assert.deepEqual(catalog.Security.EdgeConcepts, [{ Concept: "projects.Assignment", From: "from", To: "to" }]);
});
test("an owned concept populated from a connector by another package is SecuredExternalConcept", ...);
test("a document whose security names another package's concept is ForeignSecurityConcept", ...);   // tamper document.security in storage
```
`IDefinitionDescription` carries no owner, so attribution is pinned through `HomeModels` (which feeds `EnvironmentNodePlacement`'s owner) and through a placed ShareGrant's `OwnerOf`.

- [ ] **Step 2: Run them to verify they fail**

Run: `npx tsx --conditions=development --test src/engine-bridge/environment/tests/EnvironmentSecurity.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement** `EnvironmentSecurity.Compose` and wire it into `EnvironmentCatalogComposer.Compose`

If the attribution test fails because a closure manifest carries system nodes first, fix it in the composer by loading `SystemPackage.Ref` first (the system delivery is already part of the unification). Do not special-case the describer.

- [ ] **Step 4: Run tests and typecheck**

Run: `npx tsx --conditions=development --test "src/engine-bridge/environment/tests/*.test.ts" "src/engine-bridge/system/tests/*.test.ts"`, then `npm run typecheck`.
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -A src
git commit -m "feat(security): compose IEnvironmentSecurity with the environment catalog"
```

---

### Task 9: Engine-placed system fields and the system-field write guard

**Files:**
- Create: `src/engine-bridge/system/SystemFieldGuard.ts`
- Modify: `src/engine-bridge/environment/EnvironmentNodePlacement.ts`, `src/engine-bridge/EngineBridgeError.ts` (append `SystemFieldWrite`), `src/engine-bridge/index.ts`
- Modify callers: `src/engine-bridge/environment/tests/EnvironmentNodePlacement.test.ts`, `src/engine-bridge/environment/tests/EnvironmentCatalogComposer.test.ts:454`
- Test: `src/engine-bridge/environment/tests/OwnedPlacement.test.ts`

**Interfaces:**
- Consumes: `IPrincipalFacts` (Task 1), `EnvironmentSecurity.OwnedConcepts()` (Task 8), `SecurityNames` (Task 2), the engine's `Cypher.INodePlace.Defaults`. The engine's `TransactionSink` replays placement Defaults with `GraphTransaction.SetDefault`, which exempts them from Hidden/ReadOnly on a node created in the same transaction (ruling R91).
- Produces:
  ```ts
  export class EnvironmentNodePlacement implements Cypher.INodePlacement
  {
      public constructor(identity: ExternalIdentity, homeModels: ReadonlyMap<string, string>, owned: ReadonlySet<string>,
          principal: IPrincipalFacts, ids?: () => string);
      public Place(concept: string, properties: ReadonlyMap<string, CellValue>): Cypher.INodePlace;
  }
  ```
  For an engine-stored concept in `owned`:
  - `properties` holding `owner` or `owningBusinessUnit` → throw `EngineBridgeError(SystemFieldWrite)`.
  - Otherwise return `Defaults` with `owner = principal.Id` and `owningBusinessUnit = principal.HomeBusinessUnitId`.
  - External concepts never get system defaults (Task 8 rejects owned external concepts).
- Produces:
  ```ts
  export class SystemFieldGuard
  {
      /** `scope` with owner/owningBusinessUnit read-only (Create and Update stages) on todl.system.Owned; every other rule unchanged. */
      public static Guard(scope: AccessScope): AccessScope;
  }
  ```
  Rebuild through `AccessScope.Build` from `scope.Default/Rows/Hidden/HiddenExact/Writes`. Union the `Writes[todl.system.Owned].ReadOnly` sets with any existing entry. `Guard(AccessScope.System)` keeps `ReadsUnrestricted === true`. Hosts (S4) open every runtime read-write transaction under `SystemFieldGuard.Guard(scope)`, and only the assign path (Task 10) runs unguarded. Program ruling PR1: the guard applies to every runtime scope, the System Administrator's included (S3 compiles that scope as `Default: Allow` with reads unrestricted and the system fields read-only; the guard is idempotent over it).

- [ ] **Step 1: Write the failing tests**

`OwnedPlacement.test.ts` (environment from `SecFx.Hr`, principal `{ Id: "u-alice", HomeBusinessUnitId: "bu-sales" }`):
```ts
test("CREATE of an owned concept places owner and owning BU", async () =>
{
    await cypher.Execute(SystemFieldGuard.Guard(AccessScope.System), "CREATE (:hr.Employee {Name: 'Ann'})", { Placement: Fx.Placement() });
    assert.equal(await reader.GetProperty(Fx.NewId, "owner"), "u-alice");
    assert.equal(await reader.GetProperty(Fx.NewId, "owningBusinessUnit"), "bu-sales");
});
test("CREATE setting owner is refused even under System", async () =>   // Review Focus 2
    await assert.rejects(cypher.Execute(AccessScope.System, "CREATE (:hr.Employee {Name: 'Ann', owner: 'x'})", { Placement: Fx.Placement() }),
        (e: unknown) => e instanceof EngineBridgeError && e.Code === EngineBridgeErrorCode.SystemFieldWrite));
test("MERGE that creates with owningBusinessUnit is refused", ...);
test("SET owner under a guarded scope is MemberReadOnly", ...);   // AccessError, code MemberReadOnly; owner unchanged
test("an unowned concept gets no system defaults", ...);
test("a dependent package's subconcept of an owned concept gets an owner", ...);   // hr-ext.Contractor (Review Focus 4)
test("Guard(System) still reads unrestricted", () => assert.equal(SystemFieldGuard.Guard(AccessScope.System).ReadsUnrestricted, true));
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx tsx --conditions=development --test src/engine-bridge/environment/tests/OwnedPlacement.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement** the placement change, `SystemFieldGuard`, the error code, and update the two existing callers (pass `new Set()` and a fixture principal)

- [ ] **Step 4: Run tests and typecheck**

Run: `npx tsx --conditions=development --test "src/engine-bridge/**/*.test.ts"`, then `npm run typecheck`.
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -A src
git commit -m "feat(security): engine-placed owner fields and the system-field write guard"
```

---

### Task 10: The assign operation

**Files:**
- Create: `src/engine-bridge/system/OwnershipAssignment.ts`
- Modify: `src/engine-bridge/EngineBridgeError.ts` (append `NotOwned`, `InvisibleRecord`), `src/engine-bridge/index.ts`
- Test: `src/engine-bridge/system/tests/OwnershipAssignment.test.ts`

**Interfaces:**
- Consumes: `GraphTransaction` (`ConceptOf`, `SetProperty`), `EnvironmentSecurity.OwnedConcepts()`, `SecurityNames`.
- Produces:
  ```ts
  export interface IOwnerAssignment
  {
      /** The new owner: a principal id or a team id (spec §4.4). */
      readonly OwnerId: string;
      /** The owner's home BU, or the team's BU. The caller (S3/S4) resolves it from the environment setting. */
      readonly BusinessUnitId: string;
  }
  export class OwnershipAssignment
  {
      public constructor(owned: ReadonlySet<string>);
      /**
       * Records the only write that changes a record's owner/owningBusinessUnit. The caller opens `transaction` under the
       * assign scope, never under SystemFieldGuard: S3's `Tier1ScopeCompiler.CompileAssign` (program ruling PR2: Update gated
       * by the assign privilege, system fields writable), which S4 confines to the system fields with M2.3's `AssignScope`.
       */
      public Assign(transaction: GraphTransaction, record: string, owner: IOwnerAssignment): Promise<void>;
  }
  ```
  `Assign` throws `EngineBridgeError(InvisibleRecord)` when `ConceptOf(record)` is undefined (missing or hidden; the message carries no record values), `NotOwned` when the concept is not in `owned`, and `UnsupportedValue` for an empty `OwnerId`/`BusinessUnitId`. Otherwise it records exactly two `SetProperty` ops and nothing else.

- [ ] **Step 1: Write the failing tests**

```ts
test("assign changes owner and owning BU and nothing else", async () =>
{
    const t = await engine.Begin(AccessScope.System);
    await new OwnershipAssignment(catalog.Security.OwnedConcepts()).Assign(t, Fx.EmployeeId, { OwnerId: "team-hr", BusinessUnitId: "bu-hr" });
    await t.Commit();
    assert.equal(await Fx.Read(Fx.EmployeeId, "owner"), "team-hr");
    assert.equal(await Fx.Read(Fx.EmployeeId, "owningBusinessUnit"), "bu-hr");
    assert.equal(await Fx.Read(Fx.EmployeeId, "Name"), "Ann");
});
test("assign on an unowned concept is NotOwned", ...);
test("assign on a missing record is InvisibleRecord and names no value", ...);
test("assign with an empty owner id is UnsupportedValue", ...);
test("a guarded transaction cannot assign", ...);   // Begin(SystemFieldGuard.Guard(System)) → Commit rejects with AccessError MemberReadOnly
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx tsx --conditions=development --test src/engine-bridge/system/tests/OwnershipAssignment.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement `OwnershipAssignment`**

- [ ] **Step 4: Run tests and typecheck**

Run: the Step 2 command, then `npm run typecheck`.
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -A src
git commit -m "feat(security): OwnershipAssignment, the only writer of system ownership fields"
```

---

### Task 11: Forward the engine's `ConnectorContext` to every data-source call

Program ruling PR12 (index C8). **Waits on S2 Task 6** (`ConnectorContext`, `IFetchRequest.Context`, `IGraphConnector.Begin(context)`) being merged in pragmatic-graph and its `dist` rebuilt. Until then this task cannot compile; the other S1 tasks do not depend on it. TODL forwards the context and never interprets it, so no identity type enters TODL. The server (S4 Task 12) turns it into per-user source credentials inside the adapter factory it supplies.

**Files:**
- Modify: `src/model-data/data-source-adapter.ts` (`IDataSourceContext`; an optional trailing `context` parameter on `IDataSourceAdapter.Query`, `QueryPage` and `Apply`)
- Modify: `src/model-data/reconnecting-adapter.ts`, `src/model-data/version-bumping-adapter.ts` (decorators forward `context` unchanged, retries and the version bump included)
- Modify: `src/engine-bridge/external/DataSourceConnector.ts` (`Begin(context)`, `Fetch`/`Read` pass `request.Context`), `src/engine-bridge/external/DataSourceTransaction.ts` (constructor takes the context; the before-image `Query`, every `Apply` and the compensating `Apply` pass it)
- Modify: `src/index.ts` (export `IDataSourceContext` beside the other data-source contract types)
- Modify: `package.json` (`@pragmatic-tech-ai/graph` range → the S2 release)
- Test: `src/engine-bridge/external/tests/DataSourceConnectorRead.test.ts`, `src/engine-bridge/external/tests/DataSourceConnectorWrite.test.ts`, `src/model-data/tests/reconnecting-adapter.test.ts`, `src/model-data/tests/version-bumping-adapter.test.ts` (the recording fake adapter in `ExternalFixture.ts` records the context of each call)

**Interfaces:**
- Consumes: S2 Task 6 `ConnectorContext` (`Key`, `IsAnonymous`, `Anonymous`), `IFetchRequest.Context`, `IGraphConnector.Begin(context: ConnectorContext)`.
- Produces, in `data-source-adapter.ts` (`model-data` may not import the engine, so the contract is structural and `ConnectorContext` satisfies it):
  ```ts
  /** On whose behalf a data-source call runs: the engine's opaque ConnectorContext, forwarded as-is (spec §6, PR12). */
  export interface IDataSourceContext
  {
      /** Opaque key; '' is the anonymous context. Adapters with dedicated credentials ignore it. */
      readonly Key: string;
  }
  export interface IDataSourceAdapter
  {
      Query(request: QueryRequest, context?: IDataSourceContext): Promise<readonly ExternalRecord[]>;
      Apply(batch: WriteBatch, context?: IDataSourceContext): Promise<WriteResult>;
      QueryPage?(request: QueryRequest, page: PageQuery, context?: IDataSourceContext): Promise<PageSlice>;
      // other members unchanged
  }
  ```
  The parameter is optional, so existing adapters (`SqlAdapter`, fakes, adapter packs) keep compiling and ignore it.
- Produces: `DataSourceConnector.Begin(context: ConnectorContext): Promise<IConnectorTransaction>` and `new DataSourceTransaction(name, adapter, identity, context)`. The transaction keeps its context for its whole life, compensation included (S2 E11: one caller per transaction).
- Unchanged: the federated (`federated-model-data-connector.ts`), prefetch and working-copy paths, which run outside the engine and have no caller context, call without one.

- [ ] **Step 1: Write the failing tests**
  - `DataSourceConnectorRead.test.ts`: `test('fetch forwards the request context to Query')` (a `For('alice')` request reaches the fake's `Query` with Key `'alice'`); `test('a paged fetch forwards the context to QueryPage on every page')` (Resume continuations included); `test('an anonymous request is forwarded as anonymous')` (`IsAnonymous` on the recorded context).
  - `DataSourceConnectorWrite.test.ts`: `test('a transaction forwards its Begin context to the before-image read and Apply')`; `test('compensation runs on the transaction context')` (a failing second batch makes `Revert` call `Apply` with the same Key); `test('two transactions keep their contexts apart')` (alice's and bob's transactions committed concurrently: every recorded call carries its own transaction's Key).
  - `reconnecting-adapter.test.ts`: `test('a retried call keeps its context')`. `version-bumping-adapter.test.ts`: `test('the bumped Apply keeps its context')`.

- [ ] **Step 2: Run them to verify they fail**

Run: `npx tsx --conditions=development --test src/engine-bridge/external/tests/DataSourceConnectorRead.test.ts src/engine-bridge/external/tests/DataSourceConnectorWrite.test.ts src/model-data/tests/reconnecting-adapter.test.ts src/model-data/tests/version-bumping-adapter.test.ts`
Expected: FAIL (no context reaches the adapter).

- [ ] **Step 3: Implement** the contract change, the forwarding in both decorators, and the context in `DataSourceConnector`/`DataSourceTransaction`. Re-grep `adapter.Query(\|adapter.QueryPage(\|adapter.Apply(` under `src/engine-bridge/` so no engine-driven call drops the context.

- [ ] **Step 4: Run tests and typecheck**

Run: the Step 2 command, `npx tsx --conditions=development --test "src/engine-bridge/external/tests/*.test.ts" "src/model-data/tests/*.test.ts"`, then `npm run typecheck`.
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -A src package.json
git commit -m "feat(connectors): forward the engine ConnectorContext to every data-source call (PR12)"
```

---

### Task 12: Public surface, architecture docs, full verification

**Files:**
- Modify: `src/engine-bridge/tests/DevLoop.test.ts` and `src/engine-bridge/tests/EngineBridgeSurface.test.ts` (pin the new `./engine` names `EnvironmentSecurity`, `SystemFieldGuard`, `OwnershipAssignment`, `SystemFirstPackageSource`), and a root-barrel test `src/tests/security-barrel-exports.test.ts` (`SecurityAction`, `SecurityDepth`, `BaseRoleName`, `FieldProfileRight`, `SecurityTerms`, `SecurityNames`, `PackageSecurity`, `PackageSecurityCompiler`, `ReifiedOperators`; the type-only `IEdgeConcept` and `IDataSourceContext` are pinned by a compile-time import in the same file)
- Modify: `ARCHITECTURE.md` (new "Package security" subsection: syntax, `compiler-services/security/`, `CompileFoundation`, `PackageDocument.security` incl. `EdgeConcepts`, `IEnvironmentSecurity`, placement/guard/assign, ConnectorContext forwarding; `./engine` export list), `docs/ARCHITECTURE.md` (same seams)
- Modify: `package.json` `version` → the next free minor after M2.2's (a breaking surface change)

- [ ] **Step 1: Write the surface tests** (the new names are present in `Object.keys(await import(...))`) and run them

Run: `npx tsx --conditions=development --test src/tests/security-barrel-exports.test.ts src/engine-bridge/tests/DevLoop.test.ts src/engine-bridge/tests/EngineBridgeSurface.test.ts`
Expected: PASS once the exports from Tasks 2–11 are present; fix any missing export.

- [ ] **Step 2: Full suite and build**

Run: `npm test`, then `npm run build`.
Expected: all tests PASS (about 2180 plus this plan's tests). The build regenerates the prelude and the system package, and `git status` shows no diff in `src/compiler-services/stdlib/system/system-package.generated.ts` after the build.

- [ ] **Step 3: Leftover sweep**

Run: `grep -rniE "policy (<|[A-Z])|access-policy|FromRules|OwnershipSourceKind|IPrincipalFacts\['Get'\]" src docs ARCHITECTURE.md`
Expected: no hits.

- [ ] **Step 4: Commit**

```bash
git add -A src docs ARCHITECTURE.md package.json
git commit -m "docs(security): package security surface and architecture index"
```

---

## Self-review notes

- **Spec coverage:**
  - §4.4 aspect, fields and engine placement: Tasks 2, 9 and 10. Ruled PR16: owner backfill when an upgrade adds `Owned` to a concept with live records is owned by S4 Task 13 (server, as the system principal, at deploy); S1 does not backfill.
  - §4.3 package roles, contributions, package scope and unknown base role: Task 4.
  - §4.6 secured fields and profiles: Task 5, including PR8 (`security.write-without-read`).
  - §5 edge concepts (no Owned, no privileges): Tasks 4 and 6; their endpoint members reach S3/S2 as `EdgeConcepts` (PR4): Tasks 3, 7 and 8. Uniqueness and identity keys: Task 5.
  - §8 retirements in TODL: Task 1.
  - §9.4 atomic swap: Task 8.
  - §6 connector exclusion: Tasks 6 and 8. Per-caller connector work (PR12): Task 11 forwards S2's `ConnectorContext`.
  - PR1/PR2: the guard (Task 9) applies to every runtime scope; the assign scope is S3's `CompileAssign` (Task 10).
  - Enforcement (§5 visibility and the "nonexistent field" rule) is S2/S3, not S1.
- `OwnershipSourceKind`, `access-policy.json` and app-private governance have no code in TODL (they live in todl-identity and pragmatic-server). Task 1 removes everything TODL holds for tier 2.

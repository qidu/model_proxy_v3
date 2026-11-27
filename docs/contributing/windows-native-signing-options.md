---
title: Windows Native Signing Options
status: proposal — no Windows release signing is currently configured
---

# Windows Native Signing Options for Smart App Control

## 1. Problem and confirmed cause

A Windows x64 SEA executable that includes the Credential Vault packaging changes can be rejected by PowerShell with an error equivalent to:

```text
The program 'model-proxy-v3-x86_64-pc-windows-msvc.exe' cannot run:
This file has been blocked by an application control policy.
```

On the affected machine, the blocking feature is **Windows Smart App Control**, under **Windows Security → App & browser control → Smart App Control settings**. An older executable still runs.

This is not a JavaScript startup failure and is not direct evidence that `keytar.node` is defective:

- `scripts/build-sea.js` copies the Node executable and uses `postject` to inject the SEA bundle.
- Postjection changes the executable after Node's original Authenticode signature was created.
- The build re-signs macOS binaries, but currently has no corresponding Windows signing step (`scripts/build-sea.js`, steps 3–4).
- The resulting Windows executable therefore has an invalid or missing Authenticode signature and a new file hash with no established Microsoft reputation.
- Smart App Control rejects the executable before the proxy prints its startup banner or attempts to load `keytar.node` from `src/utils/key-store.ts`.

The older executable's success does not prove that its signature is valid. Smart App Control can allow an unrecognized signature state when Microsoft's app-intelligence service already has a positive reputation prediction for that exact binary. A rebuild produces a different binary and cannot inherit that file-hash reputation automatically.

Microsoft documents that, in enforcement mode, Smart App Control allows an app when it is either recognized by Microsoft's app-intelligence services or signed by a certificate issued by a CA in the Microsoft Trusted Root Program. Unknown, unsigned code is blocked by default. See [Smart App Control overview](https://learn.microsoft.com/en-us/windows/apps/develop/smart-app-control/overview).

## 2. Release requirements common to both signing options

Whichever option is selected, the Windows release pipeline must satisfy all of these requirements:

1. **Use a publicly trusted code-signing identity.** A self-signed certificate does not satisfy the normal Smart App Control trust requirement on an unmanaged user machine.
2. **Sign the final bytes.** Sign after SEA injection. Signing `node.exe` before `postject`, or retaining Node's original signature, does not sign the resulting application.
3. **Sign every native binary in the package.** This means both `model-proxy-v3-<triple>.exe` and the sibling `keytar.node`. Signing only the executable leaves a second native binary that Smart App Control can evaluate when Credential Vault is first used.
4. **Use SHA-256 and an RFC 3161 timestamp.** The timestamp allows the signature to remain verifiable after the signing certificate expires.
5. **Archive only after signing and verification.** The ZIP must contain the signed files, not the pre-signing copies.
6. **Fail the release on signing or verification failure.** Do not silently fall back to an unsigned release after credentials have been configured. SignTool warnings should also fail automation unless explicitly reviewed; SignTool can return exit code `2` for warnings.
7. **Keep private-key material out of the repository and logs.** Prefer a managed signing service or hardware-backed key. Do not commit PFX files, passwords, or exported private keys.
8. **Test the published package under Smart App Control.** A successful GitHub-hosted Windows build is not proof of Smart App Control compatibility.

The required artifact order is:

```text
bundle → generate SEA blob → copy Node → postject → stage keytar.node
       → sign exe and keytar.node → verify both signatures → create ZIP
       → test the extracted ZIP → upload/release that same ZIP
```

The current `packageWindowsBinary()` function creates the ZIP during `npm run build:native`. Implementing either signing option therefore requires moving archiving into a later step, or otherwise splitting Windows staging from ZIP creation. Signing files in `dist/` after the current build without recreating the ZIP would leave the published ZIP unsigned.

## 3. Option A — Azure Artifact Signing with GitHub OIDC (recommended)

Azure Artifact Signing, formerly called Azure Trusted Signing, provides managed access to a public-trust code-signing certificate profile. The private key remains in the managed service. GitHub Actions can authenticate with OpenID Connect (OIDC), avoiding a long-lived Azure client secret or PFX private-key file in repository secrets.

### Advantages

- No downloadable signing private key.
- Short-lived OIDC authentication instead of a stored Azure client secret.
- Managed timestamping and signing tooling through Microsoft's GitHub action.
- Suitable for both x64 and ARM64 Windows matrix jobs.
- Signing identity and access can be managed independently of developer machines.

### Costs and prerequisites

- An Azure subscription and an Artifact/Trusted Signing account.
- Completion of Microsoft's public-trust identity validation. This can require organization documents and processing time.
- A public-trust certificate profile.
- A Microsoft Entra application or managed identity authorized to use that certificate profile.
- A federated OIDC credential restricted to this repository and the intended branch, tag, or environment.
- Ongoing Azure service and operational costs.

The exact Azure role assignment and identity-validation process must be completed before workflow changes can produce a signed artifact. Creating workflow secrets alone is not sufficient.

### GitHub configuration

Use GitHub **variables** for non-secret identifiers and **secrets** only where the chosen authentication method actually requires them. With OIDC, client and tenant IDs are identifiers, not private keys.

Required configuration typically includes:

| Setting | Example or purpose |
| --- | --- |
| `AZURE_TENANT_ID` | Entra tenant used by the federated identity |
| `AZURE_CLIENT_ID` | Application/client ID used by GitHub OIDC |
| `AZURE_SUBSCRIPTION_ID` | Azure subscription containing the signing account |
| `AZURE_ARTIFACT_SIGNING_ENDPOINT` | Region-specific signing endpoint |
| `AZURE_ARTIFACT_SIGNING_ACCOUNT` | Artifact Signing account name |
| `AZURE_ARTIFACT_SIGNING_PROFILE` | Public-trust certificate profile name |

The signing job needs `id-token: write` in addition to its existing `contents` permission. The OIDC federated credential should be scoped as narrowly as practical; do not create a wildcard trust for every repository or ref.

### Workflow shape

After the Windows build stages the executable and addon, but before ZIP creation, the workflow should perform steps equivalent to:

```yaml
- name: Authenticate to Azure with OIDC
  uses: azure/login@v2
  with:
    client-id: ${{ vars.AZURE_CLIENT_ID }}
    tenant-id: ${{ vars.AZURE_TENANT_ID }}
    subscription-id: ${{ vars.AZURE_SUBSCRIPTION_ID }}

- name: Sign the Windows executable and native addon
  uses: azure/artifact-signing-action@v2
  with:
    azure-tenant-id: ${{ vars.AZURE_TENANT_ID }}
    azure-client-id: ${{ vars.AZURE_CLIENT_ID }}
    endpoint: ${{ vars.AZURE_ARTIFACT_SIGNING_ENDPOINT }}
    signing-account-name: ${{ vars.AZURE_ARTIFACT_SIGNING_ACCOUNT }}
    certificate-profile-name: ${{ vars.AZURE_ARTIFACT_SIGNING_PROFILE }}
    files-folder: ${{ github.workspace }}\dist
    files-folder-filter: exe,node
    files-folder-recurse: false
    file-digest: SHA256
    timestamp-rfc3161: http://timestamp.acs.microsoft.com
    timestamp-digest: SHA256
    exclude-workload-identity-credential: false
```

This is an integration outline, not a drop-in patch. At implementation time, review and pin the action version, confirm the action's current input names, restrict `files-folder` to the staging directory so unrelated binaries are not signed, and add a separate verification step before archiving.

### Failure policy

- On release builds, missing Azure configuration or a signing error must fail the Windows leg.
- If unsigned development artifacts remain enabled for non-release pushes, label them explicitly as unsigned and do not upload them to a GitHub release.
- Never catch a signing error and continue to `gh release upload` with the old ZIP.

## 4. Option B — CA-issued PFX and SignTool

A conventional Authenticode code-signing certificate can be stored as a PFX and used with the Windows SDK's `signtool.exe`. The certificate must chain to a CA accepted by the Microsoft Trusted Root Program and must include the code-signing enhanced key usage.

### Advantages

- Uses the standard Windows SDK signing tool.
- Does not require an Azure Artifact Signing account.
- Can be used in local release builds as well as CI.
- Straightforward signature inspection with SignTool and PowerShell.

### Costs and risks

- A publicly trusted code-signing certificate must be purchased and maintained.
- A PFX contains private-key material; storage, import, rotation, and deletion become release-security responsibilities.
- Passing a PFX password directly on a command line can expose it through process arguments or logs.
- Certificate expiry and revocation require an operational renewal process.

A hardware-backed or protected certificate store is preferable to a portable PFX. If PFX-based CI is selected, use a dedicated protected GitHub environment, restrict which refs can run the release job, store the PFX and password in encrypted secrets, import into the ephemeral runner's certificate store, select the certificate by thumbprint, and remove temporary material in an unconditional cleanup step.

### Local command shape

After SEA injection and addon staging, sign each file independently. The following example assumes an eligible certificate is already installed in the current user's certificate store and has been selected explicitly by thumbprint:

```powershell
$timestamp = 'http://timestamp.digicert.com' # Use the CA's supported RFC 3161 service.
$thumbprint = '<release-certificate-thumbprint>'
$exe = 'dist\model-proxy-v3-x86_64-pc-windows-msvc.exe'
$addon = 'dist\keytar.node'

signtool sign /sha1 $thumbprint /fd SHA256 /tr $timestamp /td SHA256 $exe
if ($LASTEXITCODE -ne 0) { throw "Executable signing failed: $LASTEXITCODE" }

signtool sign /sha1 $thumbprint /fd SHA256 /tr $timestamp /td SHA256 $addon
if ($LASTEXITCODE -ne 0) { throw "Addon signing failed: $LASTEXITCODE" }

signtool verify /pa /v $exe
if ($LASTEXITCODE -ne 0) { throw "Executable signature verification failed: $LASTEXITCODE" }

signtool verify /pa /v $addon
if ($LASTEXITCODE -ne 0) { throw "Addon signature verification failed: $LASTEXITCODE" }
```

Use the certificate authority's current timestamp endpoint rather than assuming the example endpoint is part of a particular certificate product. For local manual signing, `/n "Publisher Name"` or `/a` can select a certificate, but an explicit thumbprint is safer in automation when multiple certificates are installed.

Microsoft's reference procedure is [Use SignTool to sign a file](https://learn.microsoft.com/en-us/windows/win32/seccrypto/using-signtool-to-sign-a-file).

### CI handling

A PFX workflow should not place the password in a persistent script or command-line argument. A typical implementation instead:

1. Decodes the protected PFX secret into a file under `RUNNER_TEMP`.
2. Converts the password secret to a `SecureString` in PowerShell.
3. Imports the PFX into the ephemeral runner certificate store.
4. Signs by the expected certificate thumbprint.
5. Verifies both files and treats warnings as failures.
6. Deletes the PFX and imported certificate in `finally`/always-run cleanup.
7. Creates and uploads the ZIP only after all checks pass.

GitHub secret masking reduces accidental log disclosure but does not make a PFX private key equivalent to a managed, non-exportable key.

## 5. Option C — Keep unsigned builds and document limitations (temporary only)

This option makes no release-pipeline change. It is not a Smart App Control fix and should be used only while signing credentials are being arranged.

Available temporary workarounds are:

- Continue using the older executable when its feature set is sufficient. This does not provide the new sibling-keytar Credential Vault package.
- Run the normal Node.js distribution (`npm run build`, then `npm start`) using a trusted Node installation instead of launching an unsigned SEA executable. Any native addon loaded by that process still needs to pass Windows binary policy checks.
- Use a development machine where Smart App Control is off. Turning Smart App Control off weakens system protection, and Microsoft documents changing **Off** or **On** through Settings as a one-way operation. This is not an appropriate default instruction for end users.

`Unblock-File` only removes Mark-of-the-Web metadata. It does not create an Authenticode signature or establish Microsoft reputation, so it is not a reliable Smart App Control solution. Renaming the file, changing its extension, or recompressing the ZIP also does not establish trust. Self-signing the executable is not equivalent to signing with a publicly trusted CA.

If this option is selected temporarily, the release notes should say explicitly that Windows SEA packages may be blocked by Smart App Control. They must not claim Credential Vault packaging has been validated on a Smart App Control enforcement machine.

## 6. Verification and acceptance criteria

### Verify both signatures

Run these checks against the files extracted from the exact ZIP that will be uploaded:

```powershell
$exe = '.\model-proxy-v3-x86_64-pc-windows-msvc.exe'
$addon = '.\keytar.node'

Get-AuthenticodeSignature $exe, $addon |
  Select-Object Path, Status, StatusMessage, @{ Name = 'Signer'; Expression = { $_.SignerCertificate.Subject } }

signtool verify /pa /v $exe
signtool verify /pa /v $addon
```

Both files must report `Valid`, both SignTool commands must succeed without unreviewed warnings, and the signer must chain to the intended public trust root. Repeating verification on the extracted files catches the packaging error where `dist/` was signed but the ZIP still contained older bytes.

### Verify functionality

Run the existing Windows integration test against the extracted, signed package:

```powershell
node tests/integration/windows-keytar-sea.js .\model-proxy-v3-x86_64-pc-windows-msvc.exe
```

The test must pass all three phases: storing the test credential, retrieving it after an application restart, and deleting it. Also run `--version` and a normal proxy startup against the final executable.

### Verify under Smart App Control enforcement

Use a clean Windows test machine or VM with Smart App Control in enforcement mode:

1. Download the candidate ZIP through the same release path users will use.
2. Extract it without changing the files.
3. Start the executable and confirm that the normal startup banner appears.
4. Enable `store_key_in_system` and exercise Credential Vault so that `keytar.node` is actually loaded.
5. Restart the application and confirm that the stored key is retrieved.
6. Inspect **Event Viewer → Applications and Services Logs → Microsoft → Windows → CodeIntegrity → Operational** for blocked-file event ID `3077`.

There must be no new `3077` event for either the proxy executable or `keytar.node`. Microsoft notes that Smart App Control evaluates binaries as they load, so testing only `--version` is insufficient: the Credential Vault path must also be exercised. See [Test app signatures with Smart App Control](https://learn.microsoft.com/en-us/windows/apps/develop/smart-app-control/test-your-app-with-smart-app-control).

## 7. Recommendation and decision point

Choose **Option A, Azure Artifact Signing with GitHub OIDC**, for regular public releases. It avoids distributing a private-key file and fits the existing Windows GitHub Actions matrix. Choose **Option B** only if a publicly trusted certificate and secure PFX handling already exist, or if Azure onboarding is not acceptable. Treat **Option C** solely as a temporary documented limitation.

Before implementation, the release owner must choose one option and supply its signing infrastructure. No certificate or Azure signing account is currently defined in this repository, so documentation alone cannot produce a Smart App Control-compatible binary.

## References

- [Microsoft: Smart App Control overview](https://learn.microsoft.com/en-us/windows/apps/develop/smart-app-control/overview)
- [Microsoft: Test app signatures with Smart App Control](https://learn.microsoft.com/en-us/windows/apps/develop/smart-app-control/test-your-app-with-smart-app-control)
- [Microsoft: Use SignTool to sign a file](https://learn.microsoft.com/en-us/windows/win32/seccrypto/using-signtool-to-sign-a-file)
- [Azure: Artifact Signing GitHub action inputs](https://github.com/Azure/artifact-signing-action/blob/main/action.yml)
- [Node.js: Single executable applications](https://nodejs.org/api/single-executable-applications.html)

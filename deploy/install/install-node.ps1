# PrivaNet node installer for Windows. Installs, upgrades, repairs or removes a PrivaNode on a machine whose owner was invited by a PrivaNet Coordinator's owner.
# Documentation: docs/INSTALLER.md. Published as a release asset next to SHA256SUMS.txt and pinned to ONE release (the version below is stamped in at build time).
# Supported: Windows 10 / Windows Server 2019 or newer, x64 or ARM64, Windows PowerShell 5.1 or PowerShell 7, Node.js 24.4 or newer installed for all users.
#
#   Invoke-WebRequest https://github.com/doopydoop364/PrivaNet-Core/releases/download/vVERSION/install-node.ps1 -OutFile install-node.ps1
#   Invoke-WebRequest https://github.com/doopydoop364/PrivaNet-Core/releases/download/vVERSION/SHA256SUMS.txt -OutFile SHA256SUMS.txt
#   (compare (Get-FileHash install-node.ps1).Hash with the install-node.ps1 line of SHA256SUMS.txt, then:)  Unblock-File .\install-node.ps1
#   powershell -ExecutionPolicy Bypass -File .\install-node.ps1 -Coordinator https://node.example.com -InviteFile .\invite.txt
#
# Run it from an elevated (administrator) prompt. Nothing secret is ever put on a command line, in the environment of another process, in a file this script
# writes, in a log, or in PowerShell history/transcripts: the invite is read from a file or a hidden prompt and given to the node on its standard input.
# NOTE: the release artifacts are not Authenticode-signed (the project has no code-signing certificate); verification is the published SHA-256 list,
# an optional pin (-Sha256) obtained from the owner over another channel, and optionally GitHub's build attestation (-VerifyAttestation, needs `gh`).
[CmdletBinding()]
param(
  [string]$Coordinator = '',
  [string]$InviteFile = '',
  [string]$TokenFile = '',
  [switch]$Join,
  [switch]$InstallOnly,
  [string]$Version = '',
  [string]$CaFile = '',
  [string]$Sha256 = '',
  [switch]$VerifyAttestation,
  [string]$ReleaseBaseUrl = '',
  [string]$Capabilities = '',
  [string]$Name = '',
  [int]$Slots = 1,
  [switch]$NoService,
  [switch]$Upgrade,
  [switch]$Reinstall,
  [switch]$Repair,
  [switch]$NewIdentity,
  [switch]$Yes,
  [switch]$Uninstall,
  [switch]$Purge,
  [switch]$DryRun,
  [string]$Root = '',
  [string]$DownloadCa = '',
  [switch]$Help
)

Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'   # Invoke-WebRequest is very slow in Windows PowerShell with the progress bar

$VersionStamp = '@PRIVANET_VERSION@'
$DefaultReleases = 'https://github.com/doopydoop364/PrivaNet-Core/releases/download'
$TaskName = 'PrivaNet Node'
$NodeMin = [version]'24.4.0'
if ($env:PRIVANET_NODE_MIN) { $NodeMin = [version]$env:PRIVANET_NODE_MIN }

# Exit statuses (the same as install-node.sh): 0 done, 2 usage, 3 verification failed (nothing installed), 4 unsupported platform or missing prerequisite,
# 5 download failed, 6 installation failed, 7 enrollment failed, 8 installed but the node could not be confirmed online.
class InstallError : System.Exception {
  [int]$Code
  InstallError([int]$code, [string]$message) : base($message) { $this.Code = $code }
}
function Fail([int]$Code, [string]$Message) { throw [InstallError]::new($Code, $Message) }
function Say([string]$Text) { [Console]::Out.WriteLine($Text) }

function Show-Usage {
  Say @'
Usage: install-node.ps1 -Coordinator https://HOST[:PORT] [how to enroll] [options]
       install-node.ps1 -Uninstall [-Purge]

How to enroll (one of; none of them is ever placed on a command line or written to disk):
  -InviteFile FILE    a short invite code from the Coordinator's owner (N7K4-PQ2M), read from FILE
  (or set PRIVANET_INVITE_CODE, or answer the hidden prompt if you give none of these)
  -Join               ask to join and wait for the owner to approve (shows a request code; no secret involved)
  -TokenFile FILE     the long one-time enrollment token instead (or PRIVANET_ENROLLMENT_TOKEN)
  -InstallOnly        install the node without enrolling it (enroll later with `privanet-node enroll` or `join`)

Options:
  -Version X.Y.Z[-pre]  the release to install (default: the release this installer belongs to)
  -CaFile FILE          trust this CA certificate for the Coordinator (a private/LAN deployment; a public one needs none)
  -Sha256 HEX           also require the archive to have exactly this SHA-256 (from the owner, over another channel)
  -VerifyAttestation    also verify GitHub's build provenance for the archive (needs the `gh` command)
  -ReleaseBaseUrl URL   download from this https location instead of GitHub
  -Capabilities a,b     enroll with fewer capabilities than the invite grants       -Name NAME  a name hint shown to the owner with -Join
  -Slots N              concurrent jobs (default 1)
  -NoService            do not install or start the scheduled task that runs the node
  -Upgrade | -Reinstall | -Repair   replace the program files of an existing installation (its identity and enrollment are kept)
  -NewIdentity -Yes     give an existing installation a NEW identity (the old state is set aside, not deleted; ask the owner to revoke the old node)
  -Uninstall [-Purge]   stop and remove the task and program files (-Purge also deletes the node's identity and state)
  -DryRun               download and verify, show what would be done, change nothing
'@
}

# ---- helpers --------------------------------------------------------------------------------------------------------------------------------------------------------
function Test-Elevated {
  $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
  return ([Security.Principal.WindowsPrincipal]$identity).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

function Test-HttpsUrl([string]$Url) {
  $uri = $null
  if (-not [Uri]::TryCreate($Url, [UriKind]::Absolute, [ref]$uri)) { return $false }
  return ($uri.Scheme -eq 'https' -and -not $uri.UserInfo)
}

# Only used with -Root (the tests): trust exactly one given certificate authority for the download, with the name still checked. Never available in a real install.
# It is compiled C# rather than a script block because the callback runs on a network thread that has no PowerShell runspace.
function Enable-TestCa([string]$Path) {
  Add-Type -TypeDefinition @'
using System.Net;
using System.Net.Security;
using System.Security.Cryptography.X509Certificates;
public static class PrivaNetTestTrust {
  public static X509Certificate2 Ca;
  public static RemoteCertificateValidationCallback Callback = Check;
  public static bool Check(object sender, X509Certificate certificate, X509Chain chain, SslPolicyErrors errors) {
    if ((errors & SslPolicyErrors.RemoteCertificateNameMismatch) != 0) { return false; }
    X509Chain probe = new X509Chain();
    probe.ChainPolicy.RevocationMode = X509RevocationMode.NoCheck;
    probe.ChainPolicy.VerificationFlags = X509VerificationFlags.AllowUnknownCertificateAuthority;
    probe.ChainPolicy.ExtraStore.Add(Ca);
    probe.Build(new X509Certificate2(certificate));
    X509Certificate2 top = probe.ChainElements[probe.ChainElements.Count - 1].Certificate;
    return top.Thumbprint == Ca.Thumbprint;
  }
}
'@
  [PrivaNetTestTrust]::Ca = New-Object System.Security.Cryptography.X509Certificates.X509Certificate2 -ArgumentList (Resolve-Path -LiteralPath $Path).Path
  [System.Net.ServicePointManager]::ServerCertificateValidationCallback = [PrivaNetTestTrust]::Callback
}

# https only, certificate verification always on, and no way to be moved to another scheme by a redirect (the response is thrown away if it arrived over anything but https).
function Get-File([string]$Url, [string]$Destination) {
  if (-not (Test-HttpsUrl $Url)) { Fail 5 "refusing to download from a location that is not https: $Url" }
  try {
    $response = Invoke-WebRequest -Uri $Url -OutFile $Destination -UseBasicParsing -MaximumRedirection 5 -PassThru -TimeoutSec 900
  } catch {
    Fail 5 "could not download $Url ($($_.Exception.Message))"
  }
  $final = $null
  if ($response.BaseResponse -and ($response.BaseResponse.PSObject.Properties.Name -contains 'ResponseUri')) { $final = $response.BaseResponse.ResponseUri }
  elseif ($response.BaseResponse -and $response.BaseResponse.RequestMessage) { $final = $response.BaseResponse.RequestMessage.RequestUri }
  if ($null -ne $final -and $final.Scheme -ne 'https') { Remove-Item -LiteralPath $Destination -Force -ErrorAction SilentlyContinue; Fail 5 'the download was redirected away from https: refusing it' }
}

function Get-Sha256([string]$Path) { return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant() }

function Read-SecretFile([string]$Path) {
  $raw = [IO.File]::ReadAllText($Path)
  if ($raw.Length -gt 256) { $raw = $raw.Substring(0, 256) }
  return ($raw -replace '\s', '')
}

function Read-SecretPrompt([string]$Prompt) {
  $secure = Read-Host -Prompt $Prompt -AsSecureString
  $pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
  try { return [Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer) } finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer) }
}

# Access control by well-known SIDs (so it works on any display language): SYSTEM and Administrators full control, LOCAL SERVICE (the account the node runs as) modify.
function Protect-Directory([string]$Path) {
  & icacls.exe $Path '/inheritance:r' '/grant:r' '*S-1-5-18:(OI)(CI)F' '*S-1-5-32-544:(OI)(CI)F' '*S-1-5-19:(OI)(CI)M' | Out-Null
  if ($LASTEXITCODE -ne 0) { Fail 6 "could not restrict access to $Path" }
}
function Protect-AdminOnly([string]$Path) {
  & icacls.exe $Path '/inheritance:r' '/grant:r' '*S-1-5-18:F' '*S-1-5-32-544:F' | Out-Null
  if ($LASTEXITCODE -ne 0) { Fail 6 "could not restrict access to $Path" }
}

# Native commands write to stdout, and in PowerShell whatever a function writes becomes part of its return value. So the node's output is sent straight to the console and only the exit code is returned.
# Windows PowerShell 5.1 also turns any stderr text from a native command into a terminating error when $ErrorActionPreference is 'Stop' and stderr is redirected, so it is relaxed around these calls.
function Invoke-Node([string]$NodeCmd, [string[]]$NodeArguments, $StdIn = $null) {
  $previous = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
  try {
    # The secret (if any) goes through the pipeline into the child's standard input, never into its arguments.
    if (-not [string]::IsNullOrEmpty($StdIn)) { $StdIn | & $NodeCmd @NodeArguments | ForEach-Object { [Console]::Out.WriteLine($_) } }
    else { & $NodeCmd @NodeArguments | ForEach-Object { [Console]::Out.WriteLine($_) } }
    return $LASTEXITCODE
  } finally { $ErrorActionPreference = $previous }
}

# The standard output of a native command as one string, with its stderr discarded (see above for why the error preference is relaxed).
function Get-NativeText([string]$Command, [string[]]$CommandArguments) {
  $previous = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
  try { return (@(& $Command @CommandArguments 2>$null) -join "`n") } finally { $ErrorActionPreference = $previous }
}

# ---- the work ---------------------------------------------------------------------------------------------------------------------------------------------------------
function Install-PrivaNode {
  if ($Help) { Show-Usage; return }
  $stage = [bool]$Root
  if (-not $stage -and ($DownloadCa)) { Fail 2 '-DownloadCa exists for the installer tests and is only honoured together with -Root' }
  $programFiles = if ($stage) { Join-Path $Root 'ProgramFiles' } else { $env:ProgramFiles }
  $programData = if ($stage) { Join-Path $Root 'ProgramData' } else { $env:ProgramData }
  $optRoot = Join-Path $programFiles 'PrivaNet\node'
  $dataRoot = Join-Path $programData 'PrivaNet\node'
  $stateDir = Join-Path $dataRoot 'state'
  $configDir = Join-Path $dataRoot 'config'

  if ($Uninstall) { Uninstall-PrivaNode $optRoot $dataRoot $stateDir $stage; return }

  # ---- arguments ----
  if (-not $Coordinator) { Fail 2 '-Coordinator is required (the https address the owner gave you), for example -Coordinator https://node.example.com' }
  if (-not (Test-HttpsUrl $Coordinator)) { Fail 2 'the Coordinator address must be https and contain no credentials' }
  $Coordinator = $Coordinator.TrimEnd('/')
  if (-not $Version) {
    if ($VersionStamp -eq '@PRIVANET_VERSION@') { Fail 2 'this copy of the installer is not pinned to a release: give -Version X.Y.Z (the installer published with a release is pinned to it)' }
    $Version = $VersionStamp
  }
  if ($Version -notmatch '^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.]+)?$') { Fail 2 'the version is not a release version like 0.3.5 or 0.3.5-rc.1' }
  if ($Sha256 -and $Sha256 -notmatch '^[0-9a-fA-F]{64}$') { Fail 2 '-Sha256 must be 64 hexadecimal characters' }
  if ($Slots -lt 1 -or $Slots -gt 64) { Fail 2 '-Slots must be a number from 1 to 64' }
  if ($Capabilities -and $Capabilities -notmatch '^[a-z0-9._,-]+$') { Fail 2 '-Capabilities is a comma-separated list of capability names' }
  if ($Name -and $Name -notmatch "^[A-Za-z0-9][A-Za-z0-9 ._'-]{0,62}$") { Fail 2 '-Name may contain letters, digits, spaces and . _ - only' }
  $baseUrl = if ($ReleaseBaseUrl) { $ReleaseBaseUrl.TrimEnd('/') } else { "$DefaultReleases/v$Version" }
  if (-not (Test-HttpsUrl $baseUrl)) { Fail 2 'the release location must be https' }
  $modes = 0
  if ($InviteFile) { $modes++ }; if ($Join) { $modes++ }; if ($TokenFile) { $modes++ }
  if ($modes -gt 1) { Fail 2 'choose one way to enroll: an invite, -Join, or a token' }
  if ($InviteFile -and -not (Test-Path -LiteralPath $InviteFile -PathType Leaf)) { Fail 2 'cannot read the invite file' }
  if ($TokenFile -and -not (Test-Path -LiteralPath $TokenFile -PathType Leaf)) { Fail 2 'cannot read the token file' }
  if ($CaFile -and -not (Test-Path -LiteralPath $CaFile -PathType Leaf)) { Fail 2 'cannot read the CA file' }
  if ($NewIdentity -and -not $Yes) { Fail 2 "-NewIdentity discards this machine's identity (the old state is kept aside); add -Yes to confirm" }
  $wantEnroll = ($modes -gt 0) -or [bool]$env:PRIVANET_INVITE_CODE -or [bool]$env:PRIVANET_ENROLLMENT_TOKEN

  # ---- prerequisites ----
  if (-not [Environment]::Is64BitOperatingSystem) { Fail 4 'unsupported: PrivaNet needs a 64-bit Windows (x64 or ARM64)' }
  $arch = $env:PROCESSOR_ARCHITEW6432
  if (-not $arch) { $arch = $env:PROCESSOR_ARCHITECTURE }
  if ($stage -and $env:PRIVANET_FAKE_ARCH) { $arch = $env:PRIVANET_FAKE_ARCH }
  if ($arch -notin @('AMD64', 'x86_64', 'ARM64', 'arm64')) { Fail 4 "unsupported CPU architecture: $arch (PrivaNet supports x64 and ARM64; the program files are architecture-neutral JavaScript)" }
  if (-not $stage -and [Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT) { Fail 4 'this installer is for Windows' }
  if ($PSVersionTable.PSVersion.Major -lt 5) { Fail 4 'Windows PowerShell 5.1 or PowerShell 7 is required' }
  if (-not $stage -and -not $DryRun -and -not (Test-Elevated)) { Fail 4 'run this from an elevated prompt (Run as administrator): it installs for all users and registers a service' }
  $nodeBin = $env:PRIVANET_NODE_BIN
  if (-not $nodeBin) { $found = Get-Command node.exe -ErrorAction SilentlyContinue; if ($found) { $nodeBin = $found.Source } }
  if (-not $nodeBin -or -not (Test-Path -LiteralPath $nodeBin)) { Fail 4 "Node.js $NodeMin or newer is required and was not found. Install it for all users (https://nodejs.org) and run this again." }
  $nodeBin = (Resolve-Path -LiteralPath $nodeBin).Path
  $nodeText = Get-NativeText $nodeBin @('--version')
  if ($nodeText -notmatch '^v?([0-9]+\.[0-9]+\.[0-9]+)') { Fail 4 'could not read the Node.js version' }
  if ([version]$Matches[1] -lt $NodeMin) { Fail 4 "Node.js $($Matches[1]) is too old: PrivaNet needs $NodeMin or newer." }
  if (-not $stage -and -not $NoService -and $nodeBin.StartsWith($env:USERPROFILE, [StringComparison]::OrdinalIgnoreCase)) {
    Fail 4 'this Node.js is installed inside a user profile, where the service account cannot run it. Install Node.js for all users (the MSI installer) and run this again.'
  }
  if ($VerifyAttestation -and -not (Get-Command gh -ErrorAction SilentlyContinue)) { Fail 4 '-VerifyAttestation needs the GitHub CLI (gh)' }
  if ($DownloadCa) { Enable-TestCa $DownloadCa }

  # ---- existing installation ----
  $existing = (Test-Path -LiteralPath (Join-Path $optRoot 'current')) -or (Test-Path -LiteralPath (Join-Path $stateDir 'identity.json'))
  if ($existing -and -not ($Upgrade -or $Reinstall -or $Repair -or $NewIdentity)) {
    Fail 6 'a PrivaNet node is already installed here. Choose one: -Upgrade (replace the program files, keep this node''s identity), -NewIdentity -Yes (start over as a new node), or -Uninstall.'
  }
  $keepIdentity = $existing -and (Test-Path -LiteralPath (Join-Path $stateDir 'identity.json')) -and -not $NewIdentity -and -not $wantEnroll -and -not $InstallOnly

  # ---- the secret, read now (before anything is changed) so a mistake costs nothing ----
  $secret = ''; $secretKind = ''
  if (-not $InstallOnly -and -not $Join -and -not $keepIdentity -and -not $DryRun) {
    if ($InviteFile) { $secret = Read-SecretFile $InviteFile; $secretKind = 'invite' }
    elseif ($TokenFile) { $secret = Read-SecretFile $TokenFile; $secretKind = 'token' }
    elseif ($env:PRIVANET_INVITE_CODE) { $secret = ($env:PRIVANET_INVITE_CODE -replace '\s', ''); $secretKind = 'invite' }
    elseif ($env:PRIVANET_ENROLLMENT_TOKEN) { $secret = ($env:PRIVANET_ENROLLMENT_TOKEN -replace '\s', ''); $secretKind = 'token' }
    else { $secret = (Read-SecretPrompt 'Invite code') -replace '\s', ''; $secretKind = 'invite' }
    Remove-Item Env:\PRIVANET_INVITE_CODE -ErrorAction SilentlyContinue
    Remove-Item Env:\PRIVANET_ENROLLMENT_TOKEN -ErrorAction SilentlyContinue
    if (-not $secret) { Fail 2 'the invite or token is empty' }
    if ($secretKind -eq 'invite' -and $secret -notmatch '^[0-9A-Za-z-]{8,24}$') { Fail 2 'that does not look like an invite code (8 letters and digits, for example N7K4-PQ2M)' }
    if ($secretKind -eq 'token' -and $secret -notmatch '^[0-9a-f]{64}$') { Fail 2 'that does not look like an enrollment token (64 lowercase hexadecimal characters)' }
  }

  # ---- download and verify, before anything is changed ----
  $archive = "privanet-$Version-windows.zip"; $top = "privanet-$Version-windows"
  $temp = Join-Path ([IO.Path]::GetTempPath()) ('privanet-install-' + [Guid]::NewGuid().ToString('N'))
  [void](New-Item -ItemType Directory -Path $temp)
  try {
    if (-not $stage -and -not $DryRun) { Protect-AdminOnly $temp }
    Say "Downloading PrivaNet $Version for Windows..."
    Get-File "$baseUrl/SHA256SUMS.txt" (Join-Path $temp 'SHA256SUMS.txt')
    Get-File "$baseUrl/$archive" (Join-Path $temp $archive)
    $listed = @(Get-Content -LiteralPath (Join-Path $temp 'SHA256SUMS.txt') | Where-Object { $_ -match ('^\S+\s+\*?' + [regex]::Escape($archive) + '$') })
    if ($listed.Count -ne 1) { Fail 3 "the published checksum list does not list $archive exactly once: refusing to install." }
    $expected = ($listed[0] -split '\s+')[0].ToLowerInvariant()
    if ($expected -notmatch '^[0-9a-f]{64}$') { Fail 3 'the published checksum list is malformed: refusing to install.' }
    $actual = Get-Sha256 (Join-Path $temp $archive)
    if ($actual -ne $expected) { Fail 3 "the downloaded archive does not match its published checksum (expected $expected, got $actual): refusing to install." }
    if ($Sha256 -and $actual -ne $Sha256.ToLowerInvariant()) { Fail 3 'the downloaded archive does not match the -Sha256 you gave: refusing to install.' }
    Say "  verified: SHA-256 $actual"
    if ($VerifyAttestation) {
      & gh attestation verify (Join-Path $temp $archive) --repo 'doopydoop364/PrivaNet-Core' | Out-Null
      if ($LASTEXITCODE -ne 0) { Fail 3 "GitHub's build attestation for this archive could not be verified: refusing to install." }
      Say '  verified: GitHub build attestation'
    }

    # Unpack entry by entry into a temporary directory, refusing anything that would land outside it (zip-slip) or outside the release's own top directory.
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $extract = Join-Path $temp 'x'; [void](New-Item -ItemType Directory -Path $extract)
    $extractFull = [IO.Path]::GetFullPath($extract) + [IO.Path]::DirectorySeparatorChar
    $zip = [IO.Compression.ZipFile]::OpenRead((Join-Path $temp $archive))
    try {
      foreach ($entry in $zip.Entries) {
        $relative = $entry.FullName
        if ($relative -notmatch ('^' + [regex]::Escape($top) + '/') -or $relative -match '(^|/)\.\.(/|$)' -or $relative.StartsWith('/') -or $relative.Contains(':')) { Fail 3 'the archive contains unexpected paths: refusing to install.' }
        $target = [IO.Path]::GetFullPath((Join-Path $extract $relative))
        if (-not $target.StartsWith($extractFull, [StringComparison]::OrdinalIgnoreCase)) { Fail 3 'the archive contains unexpected paths: refusing to install.' }
        if ($relative.EndsWith('/')) { [void](New-Item -ItemType Directory -Force -Path $target); continue }
        [void](New-Item -ItemType Directory -Force -Path (Split-Path -Parent $target))
        [IO.Compression.ZipFileExtensions]::ExtractToFile($entry, $target, $true)
      }
    } finally { $zip.Dispose() }
    $src = Join-Path $extract $top
    foreach ($must in @('bin\privanet-node.cmd', 'deploy\policy\desktop-node.json', 'node_modules\@privanet\node\dist\main.js')) {
      if (-not (Test-Path -LiteralPath (Join-Path $src $must))) { Fail 3 "the archive is missing ${must}: refusing to install." }
    }

    if ($DryRun) {
      Say ''; Say 'Dry run: nothing was installed. It would:'
      Say "  - install the program files in $optRoot\$Version (and point $optRoot\current at them)"
      Say "  - create $stateDir (access: SYSTEM, Administrators, and the LOCAL SERVICE account the node runs as) and $configDir"
      Say '  - write a launcher with no secret in it and the default desktop policy'
      if (-not $NoService) { Say "  - register the scheduled task '$TaskName' (starts at boot, runs as LOCAL SERVICE, restarts on failure) and start it" }
      if ($keepIdentity) { Say "  - keep this machine's existing identity and enrollment" }
      elseif ($InstallOnly) { Say '  - not enroll (-InstallOnly)' }
      elseif ($Join) { Say "  - ask $Coordinator to let this machine join and wait for approval" }
      else { Say "  - enroll with $Coordinator using your invite or token" }
      return
    }

    # ---- install ----
    Say 'Installing...'
    if (-not $NoService -and -not $stage) { $task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue; if ($task) { Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue } }
    [void](New-Item -ItemType Directory -Force -Path $optRoot)
    $versionDir = Join-Path $optRoot $Version
    if (Test-Path -LiteralPath $versionDir) { Remove-Item -LiteralPath $versionDir -Recurse -Force }
    Copy-Item -LiteralPath $src -Destination $versionDir -Recurse
    $current = Join-Path $optRoot 'current'
    if (Test-Path -LiteralPath $current) { (Get-Item -LiteralPath $current).Delete() }
    [void](New-Item -ItemType Junction -Path $current -Target $versionDir)

    if ($NewIdentity -and (Test-Path -LiteralPath $stateDir)) {
      $aside = "$stateDir.old-" + (Get-Date -Format 'yyyyMMddHHmmss')
      Move-Item -LiteralPath $stateDir -Destination $aside
      Say "  the old identity was moved to ${aside}: ask the owner to revoke that node, then you may delete it"
    }
    [void](New-Item -ItemType Directory -Force -Path $stateDir, $configDir)
    if (-not $stage) { Protect-Directory $stateDir; Protect-AdminOnly $configDir }

    $policyFile = Join-Path $configDir 'node-policy.json'
    if (-not (Test-Path -LiteralPath $policyFile)) { Copy-Item -LiteralPath (Join-Path $src 'deploy\policy\desktop-node.json') -Destination $policyFile }
    $caCopy = ''
    if ($CaFile) { $caCopy = Join-Path $configDir 'privanet-root.crt'; Copy-Item -LiteralPath $CaFile -Destination $caCopy -Force }
    elseif (Test-Path -LiteralPath (Join-Path $configDir 'privanet-root.crt')) { $caCopy = Join-Path $configDir 'privanet-root.crt' }

    # The launcher the scheduled task runs: fixed, non-secret settings, then the node. It lives under Program Files, which only administrators can write.
    $launcher = Join-Path $versionDir 'run-node.cmd'
    $lines = @('@echo off', "rem Written by install-node.ps1 $Version. Contains no secret. The node remembers its Coordinator in its state directory after it enrolls.")
    $lines += "set `"PRIVANODE_COORDINATOR_URL=$Coordinator`""
    $lines += "set `"PRIVANODE_STATE_DIR=$stateDir`""
    $lines += "set `"PRIVANODE_POLICY_FILE=$policyFile`""
    $lines += "set `"PRIVANODE_JOB_SLOTS=$Slots`""
    if ($caCopy) { $lines += "set `"NODE_EXTRA_CA_CERTS=$caCopy`"" }
    $lines += "`"$nodeBin`" `"%~dp0node_modules\@privanet\node\dist\main.js`" %*"
    [IO.File]::WriteAllText($launcher, ($lines -join "`r`n") + "`r`n", (New-Object System.Text.ASCIIEncoding))
    $nodeCmd = $launcher

    # ---- enroll, with the secret on standard input ----
    $capArgs = @(); if ($Capabilities) { $capArgs = @('--capabilities', $Capabilities) }
    $nodeEnvironment = @{ PRIVANODE_STATE_DIR = $stateDir }
    if ($caCopy) { $nodeEnvironment['NODE_EXTRA_CA_CERTS'] = $caCopy }
    foreach ($key in $nodeEnvironment.Keys) { Set-Item -Path "Env:\$key" -Value $nodeEnvironment[$key] }
    if ($keepIdentity) { Say "  keeping this machine's identity and enrollment" }
    elseif ($InstallOnly) { Say '  installed without enrolling (-InstallOnly)' }
    elseif ($Join) {
      Say ''; Say "Asking $Coordinator to let this machine join. Give the owner the request code shown below; this waits for their approval."
      $joinArgs = @('join', '--coordinator', $Coordinator) + $capArgs
      if ($Name) { $joinArgs += @('--name', $Name) }
      $code = Invoke-Node $nodeCmd $joinArgs
      if ($code -ne 0) { Fail 7 'joining failed (see the message above)' }
    } else {
      $flag = if ($secretKind -eq 'token') { '--token-stdin' } else { '--invite-stdin' }
      $code = Invoke-Node $nodeCmd (@('enroll', '--coordinator', $Coordinator, $flag) + $capArgs) $secret
      if ($code -ne 0) { Fail 7 'enrollment failed (see the message above). The invite or token is not stored anywhere.' }
    }
    $secret = ''
    if (-not $stage -and (Test-Path -LiteralPath $stateDir)) { Protect-Directory $stateDir }   # the identity the enrollment just created gets the same restricted access

    # ---- the service: a scheduled task that runs at boot as LOCAL SERVICE and restarts if the node stops ----
    if ($NoService -or $stage) {
      Say ''; Say "Installed in $optRoot. No service was registered (-NoService/-Root). Start the node with: $nodeCmd"
      return
    }
    $action = New-ScheduledTaskAction -Execute $launcher
    $trigger = New-ScheduledTaskTrigger -AtStartup
    $principal = New-ScheduledTaskPrincipal -UserId 'NT AUTHORITY\LOCAL SERVICE' -LogonType ServiceAccount -RunLevel Limited
    $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew
    try { Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Description 'PrivaNet contributor node' -Force | Out-Null }
    catch { Fail 6 "could not register the scheduled task: $($_.Exception.Message)" }
    if ($InstallOnly) { Say ''; Say "Installed. Enroll it, then start it: Start-ScheduledTask -TaskName '$TaskName'"; return }
    try { Start-ScheduledTask -TaskName $TaskName } catch { Fail 8 "the service did not start: $($_.Exception.Message)" }

    Say 'Waiting for the node to sign in...'
    $ok = $false
    for ($attempt = 0; $attempt -lt 30 -and -not $ok; $attempt++) {
      $report = Get-NativeText $nodeCmd @('doctor', '--coordinator', $Coordinator, '--json')
      $state = (Get-ScheduledTask -TaskName $TaskName).State
      if ($report -match '"id":"registered","label":"At the Coordinator","status":"OK"' -and $state -eq 'Running') { $ok = $true } else { Start-Sleep -Seconds 2 }
    }
    if ($ok) {
      Say ''; Say 'Done. This node is installed, enrolled and signed in.'
      Say "  status:     Get-ScheduledTask -TaskName '$TaskName'"
      Say "  diagnose:   `"$nodeCmd`" doctor --coordinator $Coordinator"
      Say '  uninstall:  powershell -ExecutionPolicy Bypass -File install-node.ps1 -Uninstall [-Purge]'
      return
    }
    Say ''; Say 'The node was installed but could not be confirmed signed in. Run the doctor to see which stage fails:'
    Say "  `"$nodeCmd`" doctor --coordinator $Coordinator"
    Fail 8 'the node could not be confirmed online'
  } finally {
    $secret = ''
    if (Test-Path -LiteralPath $temp) { Remove-Item -LiteralPath $temp -Recurse -Force -ErrorAction SilentlyContinue }
  }
}

function Uninstall-PrivaNode([string]$OptRoot, [string]$DataRoot, [string]$StateDir, [bool]$Stage) {
  if (-not $Stage -and -not (Test-Elevated)) { Fail 4 'run this from an elevated prompt (Run as administrator)' }
  if (-not $Stage) {
    $task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    if ($task) { Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue; Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false; Say "  removed the scheduled task '$TaskName'" }
  }
  $current = Join-Path $OptRoot 'current'
  if (Test-Path -LiteralPath $current) { (Get-Item -LiteralPath $current).Delete() }
  if (Test-Path -LiteralPath $OptRoot) { Remove-Item -LiteralPath $OptRoot -Recurse -Force; Say "  removed $OptRoot" }
  if ($Purge) {
    if (Test-Path -LiteralPath $DataRoot) { Remove-Item -LiteralPath $DataRoot -Recurse -Force; Say '  deleted the node''s identity, state and configuration' }
    Say 'The identity is gone. Ask the Coordinator''s owner to revoke this node (privanet-admin nodes revoke), so nothing can use it.'
  } else {
    Say "  kept this node's identity and state in $DataRoot (a later install picks it up; -Purge deletes it)"
  }
  Say 'Uninstalled.'
}

try {
  Install-PrivaNode
  exit 0
} catch [InstallError] {
  [Console]::Error.WriteLine("privanet-install: $($_.Exception.Message)")
  exit $_.Exception.Code
} catch {
  [Console]::Error.WriteLine("privanet-install: unexpected failure: $($_.Exception.Message)")
  exit 6
}

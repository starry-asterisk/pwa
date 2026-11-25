using System.IO.Compression;
using System.Security.Cryptography;
using System.Text.Json;
using Velopack;
using Velopack.Exceptions;
using Velopack.Locators;
using Velopack.Sources;

if (args.Length != 2) throw new ArgumentException("Expected release directory and workspace probe directory.");
var releaseDirectory = Path.GetFullPath(args[0]);
var workDirectory = Path.GetFullPath(args[1]);
using var metadata = JsonDocument.Parse(await File.ReadAllTextAsync(Path.Combine(releaseDirectory, "windows-release.json")));
var version = metadata.RootElement.GetProperty("version").GetString()!;
var contract = metadata.RootElement.GetProperty("autoUpdate");
var packageId = contract.GetProperty("packageId").GetString()!;
var channel = contract.GetProperty("channel").GetString()!;
var feedFile = contract.GetProperty("feedFile").GetString()!;
var feed = VelopackAssetFeed.FromJson(await File.ReadAllTextAsync(Path.Combine(releaseDirectory, feedFile)));
var full = feed.Assets.Single(asset => asset.Type == VelopackAssetType.Full);
if (full.PackageId != packageId || full.Version.ToString() != version || Path.GetFileName(full.FileName) != full.FileName)
    throw new InvalidDataException("The update feed identity/version does not match the installer manifest.");
var packagePath = Path.Combine(releaseDirectory, full.FileName);
var measured = await VelopackAsset.FromNupkgGenerateChecksumAsync(packagePath);
if (!string.Equals(measured.SHA256, full.SHA256, StringComparison.OrdinalIgnoreCase) || measured.Size != full.Size
    || measured.PackageId != packageId || measured.Version.ToString() != version)
    throw new InvalidDataException("The update package does not match its feed checksum or identity.");

using (var archive = ZipFile.OpenRead(packagePath)) {
    var names = archive.Entries.Select(entry => entry.FullName.Replace('\\', '/')).ToArray();
    if (!names.Any(name => name.EndsWith("/MoaCapture.exe", StringComparison.Ordinal)))
        throw new InvalidDataException("The update package is missing its main executable.");
    foreach (var model in new[] { "eng.traineddata", "kor.traineddata", "LICENSE" })
        if (!names.Any(name => name.EndsWith("/Assets/tessdata/" + model, StringComparison.Ordinal)))
            throw new InvalidDataException("The update package is missing its OCR models or license.");
    if (names.Any(name => name.Split('/').Any(part => part.StartsWith(".env", StringComparison.OrdinalIgnoreCase))
        || name.EndsWith(".pfx", StringComparison.OrdinalIgnoreCase) || name.EndsWith(".p12", StringComparison.OrdinalIgnoreCase)))
        throw new InvalidDataException("Private build files must not be distributed in an app package.");
}

UpdateManager Manager(string currentVersion, string source, string name) {
    return ManagerFromSource(currentVersion, new SimpleFileSource(new DirectoryInfo(source)), name);
}

UpdateManager ManagerFromSource(string currentVersion, IUpdateSource source, string name) {
    var root = Path.Combine(workDirectory, name);
    var packages = Path.Combine(root, "packages");
    Directory.CreateDirectory(packages);
    var locator = new TestVelopackLocator(packageId, currentVersion, packages,
        Path.Combine(root, "current"), root, Path.Combine(root, "Update.exe"), channel);
    return new UpdateManager(source, new UpdateOptions { ExplicitChannel = channel }, locator);
}

var manager = Manager("0.0.0", releaseDirectory, "download");
var update = await manager.CheckForUpdatesAsync() ?? throw new InvalidDataException("A fresh install could not discover the packaged update.");
if (update.TargetFullRelease.Version.ToString() != version) throw new InvalidDataException("Incorrect update selected.");
await manager.DownloadUpdatesAsync(update);
var downloaded = Path.Combine(workDirectory, "download", "packages", full.FileName);
await using (var stream = File.OpenRead(downloaded)) {
    var hash = Convert.ToHexString(await SHA256.HashDataAsync(stream));
    if (!hash.Equals(full.SHA256, StringComparison.OrdinalIgnoreCase)) throw new InvalidDataException("Downloaded update checksum mismatch.");
}
if (await Manager(version, releaseDirectory, "current").CheckForUpdatesAsync() is not null)
    throw new InvalidDataException("An up-to-date app was offered an unnecessary update.");

// Exercise the same provider used by installed apps without contacting GitHub or supplying a token.
var githubDownloader = new ReleaseFixtureDownloader(releaseDirectory, feedFile, full.FileName, version);
var githubSource = new GithubSource(contract.GetProperty("repositoryUrl").GetString()!, null, false, githubDownloader);
var githubManager = ManagerFromSource("0.0.0", githubSource, "github-download");
var githubUpdate = await githubManager.CheckForUpdatesAsync() ?? throw new InvalidDataException("GitHub release assets could not discover the update.");
await githubManager.DownloadUpdatesAsync(githubUpdate);
if (!githubDownloader.DownloadedPackage) throw new InvalidDataException("GitHub updates did not use the public release asset URL.");

var corruptSource = Path.Combine(workDirectory, "corrupt-source");
Directory.CreateDirectory(corruptSource);
File.Copy(Path.Combine(releaseDirectory, feedFile), Path.Combine(corruptSource, feedFile));
await File.WriteAllTextAsync(Path.Combine(corruptSource, full.FileName), "deliberately-corrupted-test-package");
var corruptManager = Manager("0.0.0", corruptSource, "corrupt-download");
var corruptUpdate = await corruptManager.CheckForUpdatesAsync() ?? throw new InvalidDataException("Corruption test could not locate its fixture.");
try {
    await corruptManager.DownloadUpdatesAsync(corruptUpdate);
    throw new InvalidDataException("A corrupted update was accepted.");
} catch (ChecksumFailedException) { /* Expected: checksum/size validation must reject the download. */ }
Console.WriteLine("Verified package contents, local/GitHub discovery and download, current-version behavior, and corrupted-download rejection without installing.");

sealed class ReleaseFixtureDownloader(string directory, string feedFile, string packageFile, string version) : IFileDownloader {
    private const string AssetBase = "https://release.example.test/";
    public bool DownloadedPackage { get; private set; }

    private static void AssertPublic(IDictionary<string, string>? headers) {
        if (headers?.Keys.Any(name => name.Equals("Authorization", StringComparison.OrdinalIgnoreCase)) == true)
            throw new InvalidDataException("Public app updates must not require a GitHub token.");
    }

    private string LocalAsset(string url, IDictionary<string, string>? headers) {
        AssertPublic(headers);
        if (!url.StartsWith(AssetBase, StringComparison.Ordinal)) throw new InvalidDataException("Unexpected test download URL.");
        var name = Uri.UnescapeDataString(new Uri(url).AbsolutePath.TrimStart('/'));
        if (name != feedFile && name != packageFile) throw new InvalidDataException("Unexpected release asset requested.");
        return Path.Combine(directory, name);
    }

    public Task<string> DownloadString(string url, IDictionary<string, string>? headers = null, double timeout = 30) {
        AssertPublic(headers);
        if (url.StartsWith("https://api.github.com/repos/", StringComparison.Ordinal) && url.Contains("/releases?", StringComparison.Ordinal)) {
            var assets = new[] { feedFile, packageFile }.Select(name => new {
                name, browser_download_url = AssetBase + Uri.EscapeDataString(name),
                url = "https://api.github.com/test-assets/" + Uri.EscapeDataString(name), content_type = "application/octet-stream",
            });
            var releases = new[] { new { name = "Moa Capture " + version, prerelease = false,
                published_at = "2026-01-01T00:00:00Z", assets } };
            return Task.FromResult(JsonSerializer.Serialize(releases));
        }
        return File.ReadAllTextAsync(LocalAsset(url, headers));
    }

    public Task<byte[]> DownloadBytes(string url, IDictionary<string, string>? headers = null, double timeout = 30) =>
        File.ReadAllBytesAsync(LocalAsset(url, headers));

    public Task DownloadFile(string url, string targetFile, Action<int> progress, IDictionary<string, string>? headers = null,
        double timeout = 30, CancellationToken cancelToken = default) {
        cancelToken.ThrowIfCancellationRequested();
        var source = LocalAsset(url, headers);
        File.Copy(source, targetFile, true);
        DownloadedPackage = Path.GetFileName(source) == packageFile;
        progress(100);
        return Task.CompletedTask;
    }
}

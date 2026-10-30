using System.Collections.Concurrent;
using System.Diagnostics;
using System.Reflection.PortableExecutable;
using ICSharpCode.Decompiler;
using ICSharpCode.Decompiler.CSharp;
using ICSharpCode.Decompiler.CSharp.OutputVisitor;
using ICSharpCode.Decompiler.CSharp.Syntax;
using ICSharpCode.Decompiler.Metadata;
using ICSharpCode.Decompiler.TypeSystem;

// Decompiles whole assemblies to .cs files: one per top-level type, in folders by namespace, under
// <output folder>/<assembly>/. Each assembly's folder is replaced. Run by decompile.ts.
//
// Cli <game folder> <reference folder> <output folder> <assembly>...
//   game folder        the game's assemblies and PDBs, side by side
//   reference folder   the .NET reference pack (packs/Microsoft.NETCore.App.Ref/<version>/ref/net10.0)

if (args.Length < 4)
{
	Console.Error.WriteLine("Usage: Cli <game folder> <reference folder> <output folder> <assembly>...");
	return 2;
}
var (gameFolder, referenceFolder, outputFolder) = (args[0], args[1], args[2]);
var settings = Decompilation.CreateSettings();
var resolver = new FolderResolver([gameFolder, referenceFolder]);
var failures = new ConcurrentBag<string>();

foreach (var assembly in args[3..])
{
	var module = resolver.Load(assembly);
	if (module == null)
	{
		Console.Error.WriteLine($"{assembly}.dll is not in {gameFolder}");
		return 1;
	}
	var watch = Stopwatch.StartNew();
	var pdbPath = Path.Combine(gameFolder, assembly + ".pdb");
	var pdb = File.Exists(pdbPath) ? new PdbProvider(File.ReadAllBytes(pdbPath)) : null;
	var typeSystem = new DecompilerTypeSystem(module, resolver, settings);
	var types = typeSystem.MainModule.TypeDefinitions
		.Where(td => td.DeclaringTypeDefinition == null && !Decompilation.IsHidden(td))
		.ToList();
	var root = Path.Combine(outputFolder, assembly);
	if (Directory.Exists(root))
		Directory.Delete(root, recursive: true);
	var paths = FilePaths(types, root);

	var done = 0;
	var reported = Stopwatch.StartNew();
	Parallel.ForEach(types, td =>
	{
		var decompiler = new CSharpDecompiler(typeSystem, settings) { DebugInfoProvider = pdb };
		string text;
		try
		{
			text = Print(decompiler.DecompileType(td.FullTypeName));
		}
		catch (Exception e)
		{
			failures.Add($"{assembly}: {td.ReflectionName}: {e.Message}");
			text = $"// Decompiling {td.ReflectionName} failed: {e.Message}\n";
		}
		var path = paths[td];
		Directory.CreateDirectory(Path.GetDirectoryName(path)!);
		File.WriteAllText(path, text);
		var n = Interlocked.Increment(ref done);
		if (!Console.IsOutputRedirected && reported.ElapsedMilliseconds > 200)
			lock (reported)
			{
				reported.Restart();
				Console.Write($"\r{assembly}: {n}/{types.Count} types");
			}
	});
	lock (reported)
		Console.WriteLine($"\r{assembly}: {types.Count} types in {watch.Elapsed.TotalSeconds:F1} s");
}

foreach (var failure in failures.Order())
	Console.Error.WriteLine(failure);
if (!failures.IsEmpty)
	Console.Error.WriteLine($"{failures.Count} types failed to decompile; their files say why.");
return 0;

/// <summary>C# source as the page shows it, without the highlighting: tab-indented, LF line endings.</summary>
string Print(SyntaxTree tree)
{
	var writer = new StringWriter { NewLine = "\n" };
	tree.AcceptVisitor(new InsertParenthesesVisitor { InsertParenthesesForReadability = true });
	tree.AcceptVisitor(new CSharpOutputVisitor(new TextWriterTokenWriter(writer) { IndentationString = "\t" }, settings.CSharpFormattingOptions));
	return writer.ToString();
}

/// <summary>
/// root/Name/Space/Type.cs for each type; generic types keep their arity (List`1.cs). Paths that
/// would collide on a case-insensitive file system get a number (Type.2.cs).
/// </summary>
static Dictionary<ITypeDefinition, string> FilePaths(List<ITypeDefinition> types, string root)
{
	var taken = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
	var paths = new Dictionary<ITypeDefinition, string>();
	foreach (var td in types.OrderBy(t => t.ReflectionName, StringComparer.Ordinal))
	{
		var folder = Path.Combine([root, .. td.Namespace.Split('.', StringSplitOptions.RemoveEmptyEntries).Select(FileName)]);
		var name = FileName(td.TypeParameterCount > 0 ? $"{td.Name}`{td.TypeParameterCount}" : td.Name);
		var path = Path.Combine(folder, name + ".cs");
		for (var i = 2; !taken.Add(path); i++)
			path = Path.Combine(folder, $"{name}.{i}.cs");
		paths[td] = path;
	}
	return paths;
}

/// <summary>A name that is a valid file name on Windows too, so the output can be copied anywhere.</summary>
static string FileName(string name)
{
	var chars = name.Select(c => c < ' ' || "<>:\"/\\|?*".Contains(c) ? '_' : c).ToArray();
	var result = new string(chars).TrimEnd('.', ' ');
	string[] devices = ["CON", "PRN", "AUX", "NUL", "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8", "COM9",
		"LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9"];
	return result.Length == 0 || devices.Contains(result, StringComparer.OrdinalIgnoreCase) ? "_" + result : result;
}

/// <summary>Resolves references by simple name from the given folders, first match first; missing ones stay unresolved.</summary>
sealed class FolderResolver(string[] folders) : IAssemblyResolver
{
	readonly ConcurrentDictionary<string, MetadataFile?> cache = new(StringComparer.OrdinalIgnoreCase);

	public MetadataFile? Load(string name) => cache.GetOrAdd(name, _ =>
	{
		foreach (var folder in folders)
		{
			var path = Path.Combine(folder, name + ".dll");
			if (File.Exists(path))
				return new PEFile(path, File.OpenRead(path), PEStreamOptions.PrefetchEntireImage);
		}
		return null;
	});

	public MetadataFile? Resolve(IAssemblyReference reference) => Load(reference.Name);
	public MetadataFile? ResolveModule(MetadataFile mainModule, string moduleName) => null;
	public Task<MetadataFile?> ResolveAsync(IAssemblyReference reference) => Task.FromResult(Resolve(reference));
	public Task<MetadataFile?> ResolveModuleAsync(MetadataFile mainModule, string moduleName) => Task.FromResult<MetadataFile?>(null);
	public IDisposable BeginSnapshot() => new MemoryStream();
}

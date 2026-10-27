using System.Collections.Immutable;
using System.Diagnostics;
using System.Reflection.Metadata;
using System.Reflection.Metadata.Ecma335;
using System.Reflection.PortableExecutable;
using System.Runtime.InteropServices.JavaScript;
using System.Text;
using ICSharpCode.Decompiler;
using ICSharpCode.Decompiler.CSharp;
using ICSharpCode.Decompiler.CSharp.OutputVisitor;
using ICSharpCode.Decompiler.CSharp.Syntax;
using ICSharpCode.Decompiler.DebugInfo;
using ICSharpCode.Decompiler.Disassembler;
using ICSharpCode.Decompiler.Metadata;
using ICSharpCode.Decompiler.TypeSystem;
using SequencePoint = ICSharpCode.Decompiler.DebugInfo.SequencePoint;

// Only ever runs in the browser; without this, every [JSExport] (browser-only) raises CA1416.
[assembly: System.Runtime.Versioning.SupportedOSPlatform("browser")]

// The runtime only needs an entry point to exist; all work goes through the [JSExport] methods.
return;

/// <summary>Entry points called from worker.ts. All data crosses as byte[] in and TSV/HTML strings out.</summary>
static partial class Exports
{
	/// <summary>Every loaded file, keyed by lowercase file name ("vintagestorylib.dll").</summary>
	static readonly Dictionary<string, byte[]> files = new(StringComparer.OrdinalIgnoreCase);
	/// <summary>File names that belong to the bundled .NET reference pack, which survive <see cref="Clear"/>.</summary>
	static readonly HashSet<string> framework = new(StringComparer.OrdinalIgnoreCase);
	static readonly Dictionary<string, CSharpDecompiler> decompilers = new(StringComparer.OrdinalIgnoreCase);
	static Resolver resolver = new(files);
	static string version = "";
	static readonly DecompilerSettings settings = new(LanguageVersion.Latest)
	{
		ThrowOnAssemblyResolveErrors = false,
		FileScopedNamespaces = true,
		ShowXmlDocumentation = false,
	};
	/// <summary>Assemblies shown in the tree; references into these become links.</summary>
	static readonly HashSet<string> browsed = new(StringComparer.OrdinalIgnoreCase);

	public static bool IsBrowsed(string assembly) => browsed.Contains(assembly);

	[JSExport]
	public static void AddFile(string name, byte[] data, bool isFramework)
	{
		files[name] = data;
		if (isFramework)
			framework.Add(name);
	}

	/// <summary>Drops the game files and every cached type system, keeping the reference pack.</summary>
	[JSExport]
	public static void Clear()
	{
		foreach (var name in files.Keys.Where(n => !framework.Contains(n)).ToList())
			files.Remove(name);
		decompilers.Clear();
		resolver = new Resolver(files);
		version = "";
	}

	/// <summary>
	/// Reads one assembly's identity without keeping it. Line 1: name, AssemblyInformationalVersion,
	/// the GameVersion.ShortGameVersion constant (only VintagestoryAPI has it), AssemblyFileVersion,
	/// assembly version, empty where absent; then one line per referenced assembly name.
	/// </summary>
	[JSExport]
	public static string Inspect(byte[] data)
	{
		using var pe = new PEReader(ImmutableArray.Create(data));
		if (!pe.HasMetadata)
			return "";
		var md = pe.GetMetadataReader();
		if (!md.IsAssembly)
			return "";
		var asm = md.GetAssemblyDefinition();
		string? informational = null, file = null;
		foreach (var handle in asm.GetCustomAttributes())
		{
			var attr = md.GetCustomAttribute(handle);
			if (attr.Constructor.Kind != HandleKind.MemberReference)
				continue;
			var parent = md.GetMemberReference((MemberReferenceHandle)attr.Constructor).Parent;
			if (parent.Kind != HandleKind.TypeReference)
				continue;
			var typeName = md.GetString(md.GetTypeReference((TypeReferenceHandle)parent).Name);
			if (typeName is not ("AssemblyInformationalVersionAttribute" or "AssemblyFileVersionAttribute"))
				continue;
			var blob = md.GetBlobReader(attr.Value);
			if (blob.ReadUInt16() != 1)
				continue;
			var value = blob.ReadSerializedString();
			if (typeName == "AssemblyInformationalVersionAttribute")
				informational = value;
			else
				file = value;
		}
		var sb = new StringBuilder();
		sb.Append(md.GetString(asm.Name)).Append('\t').Append(informational).Append('\t').Append(FindGameVersion(md))
			.Append('\t').Append(file).Append('\t').Append(asm.Version).Append('\n');
		foreach (var r in md.AssemblyReferences)
			sb.Append(md.GetString(md.GetAssemblyReference(r).Name)).Append('\n');
		return sb.ToString();
	}

	static string? FindGameVersion(MetadataReader md)
	{
		foreach (var th in md.TypeDefinitions)
		{
			var td = md.GetTypeDefinition(th);
			if (md.GetString(td.Name) != "GameVersion" || md.GetString(td.Namespace) != "Vintagestory.API.Config")
				continue;
			foreach (var fh in td.GetFields())
			{
				var field = md.GetFieldDefinition(fh);
				var constant = field.GetDefaultValue();
				if (md.GetString(field.Name) != "ShortGameVersion" || constant.IsNil)
					continue;
				var c = md.GetConstant(constant);
				if (c.TypeCode != ConstantTypeCode.String)
					continue;
				var blob = md.GetBlobReader(c.Value);
				return blob.ReadUTF16(blob.Length);
			}
		}
		return null;
	}

	/// <summary>
	/// Builds the type systems for the given assemblies and lists what can be browsed, one TSV line each:
	/// <c>T assembly reflectionName kind topLevelReflectionName token</c> for types and
	/// <c>M assembly displayName kind topLevelReflectionName token declaringReflectionName</c> for members.
	/// </summary>
	[JSExport]
	public static string Open(string gameVersion, string[] assemblies)
	{
		version = gameVersion;
		browsed.Clear();
		browsed.UnionWith(assemblies);
		var sb = new StringBuilder();
		foreach (var name in assemblies)
		{
			var module = Get(name).TypeSystem.MainModule;
			foreach (var td in module.TypeDefinitions)
			{
				if (IsHidden(td))
					continue;
				var top = td;
				while (top.DeclaringTypeDefinition is { } outer)
					top = outer;
				if (IsHidden(top))
					continue;
				sb.Append("T\t").Append(name).Append('\t').Append(td.ReflectionName).Append('\t')
					.Append(KindOf(td)).Append('\t').Append(top.ReflectionName).Append('\t')
					.Append(Token(td)).Append('\n');
				foreach (var member in td.Members)
				{
					if (member.Name.StartsWith('<') || member is IMethod { IsAccessor: true } || member is IMethod { IsConstructor: true }
						|| member.IsCompilerGenerated())
						continue;
					var display = member is IMethod m
						? m.Name + "(" + string.Join(", ", m.Parameters.Select(p => p.Type.Name)) + ")"
						: member.Name;
					sb.Append("M\t").Append(name).Append('\t').Append(display).Append('\t')
						.Append(member.SymbolKind switch
						{
							SymbolKind.Method or SymbolKind.Operator => "method",
							SymbolKind.Field => "field",
							SymbolKind.Event => "event",
							_ => "property",
						})
						.Append('\t').Append(top.ReflectionName).Append('\t').Append(Token(member)).Append('\t')
						.Append(td.ReflectionName).Append('\n');
				}
			}
		}
		return sb.ToString();
	}

	/// <summary>Decompiles one top-level type to highlighted HTML (the inside of a &lt;code&gt; element).</summary>
	[JSExport]
	public static string Decompile(string assembly, string reflectionName)
	{
		var decompiler = Get(assembly);
		var watch = Stopwatch.StartNew();
		var tree = decompiler.DecompileType(new FullTypeName(reflectionName));
		var output = new HtmlOutput(version);
		tree.AcceptVisitor(new InsertParenthesesVisitor { InsertParenthesesForReadability = true });
		var writer = new HighlightWriter(new TextTokenWriter(output, settings), output);
		tree.AcceptVisitor(new CSharpOutputVisitor(writer, settings.CSharpFormattingOptions));
		Console.WriteLine($"decompiled {reflectionName} in {watch.ElapsedMilliseconds} ms");
		return output.ToString();
	}

	static CSharpDecompiler Get(string assembly)
	{
		if (decompilers.TryGetValue(assembly, out var cached))
			return cached;
		var module = resolver.Load(assembly) ?? throw new InvalidOperationException($"{assembly}.dll is not loaded");
		var decompiler = new CSharpDecompiler(module, resolver, settings);
		if (files.TryGetValue(assembly + ".pdb", out var pdb))
			decompiler.DebugInfoProvider = new PdbProvider(pdb);
		decompilers[assembly] = decompiler;
		return decompiler;
	}

	static bool IsHidden(ITypeDefinition td) => td.Name.StartsWith('<') || td.Name.Contains("<>") || td.IsCompilerGenerated();

	static string KindOf(ITypeDefinition td) => td.Kind switch
	{
		TypeKind.Interface => "interface",
		TypeKind.Struct => "struct",
		TypeKind.Enum => "enum",
		TypeKind.Delegate => "delegate",
		_ => td.IsStatic ? "static" : td.IsAbstract ? "abstract" : "class",
	};

	/// <summary>Metadata token as 8 hex digits: unique per assembly and stable for the version, so it is the anchor id.</summary>
	public static string Token(IEntity entity) => MetadataTokens.GetToken(entity.MetadataToken).ToString("x8");
}

/// <summary>Resolves references by simple name from the files sent over from JS; missing ones stay unresolved.</summary>
sealed class Resolver(Dictionary<string, byte[]> files) : IAssemblyResolver
{
	readonly Dictionary<string, MetadataFile?> cache = new(StringComparer.OrdinalIgnoreCase);

	public MetadataFile? Load(string name)
	{
		if (cache.TryGetValue(name, out var cached))
			return cached;
		MetadataFile? file = null;
		if (files.TryGetValue(name + ".dll", out var data))
			file = new PEFile(name + ".dll", new MemoryStream(data, writable: false), PEStreamOptions.PrefetchEntireImage);
		cache[name] = file;
		return file;
	}

	public MetadataFile? Resolve(IAssemblyReference reference) => Load(reference.Name);
	public MetadataFile? ResolveModule(MetadataFile mainModule, string moduleName) => null;
	// The browser runtime is single-threaded, so the async variants complete synchronously.
	public Task<MetadataFile?> ResolveAsync(IAssemblyReference reference) => Task.FromResult(Resolve(reference));
	public Task<MetadataFile?> ResolveModuleAsync(MetadataFile mainModule, string moduleName) => Task.FromResult<MetadataFile?>(null);
	public IDisposable BeginSnapshot() => new MemoryStream();
}

/// <summary>Local variable names from a portable PDB. Sequence points are not needed for display.</summary>
sealed class PdbProvider : IDebugInfoProvider
{
	readonly MetadataReader reader;

	public PdbProvider(byte[] pdb)
	{
		reader = MetadataReaderProvider.FromPortablePdbImage(ImmutableArray.Create(pdb)).GetMetadataReader();
	}

	public string Description => "Portable PDB";
	public string SourceFileName => "";

	public IList<SequencePoint> GetSequencePoints(MethodDefinitionHandle method) => [];

	public IList<Variable> GetVariables(MethodDefinitionHandle method)
	{
		var list = new List<Variable>();
		foreach (var scope in reader.GetLocalScopes(method))
			foreach (var vh in reader.GetLocalScope(scope).GetLocalVariables())
			{
				var v = reader.GetLocalVariable(vh);
				list.Add(new Variable(v.Index, reader.GetString(v.Name)));
			}
		return list;
	}

	public bool TryGetName(MethodDefinitionHandle method, int index, out string name)
	{
		foreach (var scope in reader.GetLocalScopes(method))
			foreach (var vh in reader.GetLocalScope(scope).GetLocalVariables())
			{
				var v = reader.GetLocalVariable(vh);
				if (v.Index == index && (v.Attributes & LocalVariableAttributes.DebuggerHidden) == 0)
				{
					name = reader.GetString(v.Name);
					return true;
				}
			}
		name = null!;
		return false;
	}

	public bool TryGetExtraTypeInfo(MethodDefinitionHandle method, int index, out PdbExtraTypeInfo extraTypeInfo)
	{
		extraTypeInfo = default;
		return false;
	}
}

/// <summary>
/// Wraps literal, keyword and comment tokens in spans. References (types, members, locals) are
/// coloured by <see cref="HtmlOutput"/> instead, since TextTokenWriter has already resolved them.
/// </summary>
sealed class HighlightWriter(TokenWriter inner, HtmlOutput output) : DecoratingTokenWriter(inner)
{
	public override void WriteKeyword(string keyword)
	{
		output.Open("k");
		base.WriteKeyword(keyword);
		output.Close();
	}

	public override void WritePrimitiveType(string type)
	{
		output.Open("k");
		base.WritePrimitiveType(type);
		output.Close();
	}

	public override void WritePrimitiveValue(object? value, LiteralFormat format = LiteralFormat.None)
	{
		output.Open(value switch
		{
			string or char => "s",
			null or bool => "k",
			_ => "n",
		});
		base.WritePrimitiveValue(value, format);
		output.Close();
	}

	public override void WriteInterpolatedText(string text)
	{
		output.Open("s");
		base.WriteInterpolatedText(text);
		output.Close();
	}

	public override void WriteComment(CommentType commentType, string content)
	{
		output.Open("c");
		base.WriteComment(commentType, content);
		output.Close();
	}

	public override void WritePreProcessorDirective(PreProcessorDirectiveType type, string? argument)
	{
		output.Open("c");
		base.WritePreProcessorDirective(type, argument);
		output.Close();
	}
}

/// <summary>
/// Collects decompiled text as escaped HTML. Definitions carry an id of their metadata token;
/// references into the browsed assemblies become links of the page's own hash route.
/// </summary>
sealed class HtmlOutput(string version) : ITextOutput
{
	readonly StringBuilder sb = new();
	int indent;
	bool lineStart = true;
	/// <summary>Inside a keyword span (e.g. <c>int</c>, which also resolves to System.Int32), references keep keyword colour.</summary>
	int keywordDepth;
	readonly Stack<string> open = new();

	public string IndentationString { get; set; } = "\t";

	void BeginText()
	{
		if (!lineStart)
			return;
		lineStart = false;
		for (int i = 0; i < indent; i++)
			sb.Append(IndentationString);
	}

	public void Open(string cls)
	{
		BeginText();
		open.Push(cls);
		if (cls == "k")
			keywordDepth++;
		sb.Append("<span class=").Append(cls).Append('>');
	}

	public void Close()
	{
		if (open.Pop() == "k")
			keywordDepth--;
		sb.Append("</span>");
	}

	void Escape(string text)
	{
		foreach (var ch in text)
			Escape(ch);
	}

	void Escape(char ch)
	{
		switch (ch)
		{
			case '<': sb.Append("&lt;"); break;
			case '>': sb.Append("&gt;"); break;
			case '&': sb.Append("&amp;"); break;
			case '"': sb.Append("&quot;"); break;
			default: sb.Append(ch); break;
		}
	}

	public void Indent() => indent++;
	public void Unindent() => indent--;

	public void Write(char ch)
	{
		BeginText();
		Escape(ch);
	}

	public void Write(string text)
	{
		BeginText();
		Escape(text);
	}

	public void WriteLine()
	{
		sb.Append('\n');
		lineStart = true;
	}

	public void WriteReference(OpCodeInfo opCode, bool omitSuffix = false) => Write(opCode.Name);

	public void WriteReference(MetadataFile metadata, Handle handle, string text, string protocol = "decompile", bool isDefinition = false) => Write(text);

	public void WriteReference(IType type, string text, bool isDefinition = false)
	{
		var td = type.GetDefinition();
		Entity(td, td, "t", text, isDefinition, type.ReflectionName);
	}

	public void WriteReference(IMember member, string text, bool isDefinition = false)
	{
		var def = member.MemberDefinition;
		var cls = def.SymbolKind switch
		{
			SymbolKind.Method or SymbolKind.Operator or SymbolKind.Constructor or SymbolKind.Destructor => "m",
			_ => "f",
		};
		Entity(def, def.DeclaringTypeDefinition, cls, text, isDefinition, def.DeclaringType.ReflectionName + "." + def.Name);
	}

	/// <param name="entity">The definition referenced, when it could be resolved.</param>
	/// <param name="type">The type that holds it; links go to that type's outermost declaring type.</param>
	void Entity(IEntity? entity, ITypeDefinition? type, string cls, string text, bool isDefinition, string title)
	{
		BeginText();
		if (keywordDepth > 0)
		{
			Escape(text);
			return;
		}
		if (isDefinition && entity != null)
		{
			sb.Append("<span class=").Append(cls).Append(" id=d").Append(Exports.Token(entity)).Append('>');
			Escape(text);
			sb.Append("</span>");
			return;
		}
		var top = type;
		while (top?.DeclaringTypeDefinition is { } outer)
			top = outer;
		var assembly = top?.ParentModule?.AssemblyName;
		if (entity != null && top != null && assembly != null && Exports.IsBrowsed(assembly))
		{
			sb.Append("<a class=").Append(cls).Append(" href=\"#v=").Append(Uri.EscapeDataString(version))
				.Append("&amp;a=").Append(Uri.EscapeDataString(assembly))
				.Append("&amp;t=").Append(Uri.EscapeDataString(top.ReflectionName));
			if (!ReferenceEquals(entity, top))
				sb.Append("&amp;m=").Append(Exports.Token(entity));
			sb.Append("\">");
			Escape(text);
			sb.Append("</a>");
			return;
		}
		sb.Append("<span class=").Append(cls).Append(" title=\"");
		Escape(title);
		sb.Append("\">");
		Escape(text);
		sb.Append("</span>");
	}

	public void WriteLocalReference(string text, object reference, bool isDefinition = false, bool isHoverOnly = false)
	{
		Open("v");
		Escape(text);
		Close();
	}

	public void MarkFoldStart(string collapsedText = "...", bool defaultCollapsed = false, bool isDefinition = false) { }
	public void MarkFoldEnd() { }
	public void MarkDefinitionStart() { }

	public override string ToString() => sb.ToString();
}

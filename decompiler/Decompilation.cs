using ICSharpCode.Decompiler;
using ICSharpCode.Decompiler.CSharp;
using ICSharpCode.Decompiler.TypeSystem;

/// <summary>What the page and <c>bun run decompile</c> (cli/) share, so both show the same code.</summary>
static class Decompilation
{
	public static DecompilerSettings CreateSettings() => new(LanguageVersion.Latest)
	{
		ThrowOnAssemblyResolveErrors = false,
		FileScopedNamespaces = true,
		ShowXmlDocumentation = false,
	};

	/// <summary>Compiler-generated types, which are decompiled as part of the code that uses them.</summary>
	public static bool IsHidden(ITypeDefinition td) => td.Name.StartsWith('<') || td.Name.Contains("<>") || td.IsCompilerGenerated();
}

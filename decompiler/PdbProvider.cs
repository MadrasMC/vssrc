using System.Collections.Immutable;
using System.Reflection.Metadata;
using ICSharpCode.Decompiler.DebugInfo;
using SequencePoint = ICSharpCode.Decompiler.DebugInfo.SequencePoint;

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

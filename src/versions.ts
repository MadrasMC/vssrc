// Linux client downloads, picked out of api.vintagestory.at's manifests. Used by build.ts to write
// the bundled list (src/versions.json) and by the page to read the live one, so both agree.

export type Branch = "stable" | "unstable";

/** A Linux client download. */
export interface Download {
	version: string;
	branch: Branch;
	file: string;
	/** As the API writes it, e.g. "590.5 MB". */
	size: string;
	url: string;
}

/** One api.vintagestory.at manifest ({stable,unstable}.json): version -> platform -> download. */
export type Manifest = Record<string, Record<string, { filename?: unknown; filesize?: unknown; urls?: { cdn?: unknown } } | undefined> | undefined>;

/**
 * The Linux client downloads of both manifests, newest first within each branch. Entries without
 * the expected fields are skipped, so a changed or partial manifest yields fewer rows, not an error.
 */
export function linuxDownloads(manifests: Record<Branch, Manifest>): Download[] {
	const downloads: Download[] = [];
	for (const branch of ["stable", "unstable"] as const)
		for (const [version, platforms] of Object.entries(manifests[branch] ?? {})) {
			const linux = platforms?.linux;
			if (typeof linux?.filename === "string" && typeof linux.filesize === "string" && typeof linux.urls?.cdn === "string")
				downloads.push({ version, branch, file: linux.filename, size: linux.filesize, url: linux.urls.cdn });
		}
	return downloads.sort((a, b) => a.branch.localeCompare(b.branch) || b.version.localeCompare(a.version, undefined, { numeric: true }));
}

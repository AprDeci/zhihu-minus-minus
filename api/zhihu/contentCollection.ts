export interface ContentCollectionMetadata {
  isCollected?: boolean;
  favlistsCount?: number;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** Preserve unknown state and counts while accepting the Web, App and feed shapes. */
export function getContentCollectionMetadata(
  value: unknown,
): ContentCollectionMetadata {
  const source = record(value);
  const reaction = record(source?.reaction);
  const relation = record(reaction?.relation);
  const relationship = record(source?.relationship);
  const virtuals = record(source?.virtuals);
  const statistics = record(reaction?.statistics);
  const isCollected = [
    source?.isCollected,
    relation?.faved,
    relationship?.is_favorited,
    virtuals?.is_favorited,
  ].find((candidate): candidate is boolean => typeof candidate === 'boolean');
  const favlistsCount = [
    source?.favlistsCount,
    source?.favlists_count,
    source?.favorite_count,
    statistics?.favorites,
  ].find(
    (candidate): candidate is number =>
      typeof candidate === 'number' &&
      Number.isSafeInteger(candidate) &&
      candidate >= 0,
  );
  return {
    ...(isCollected !== undefined && { isCollected }),
    ...(favlistsCount !== undefined && { favlistsCount }),
  };
}

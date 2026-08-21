const escapeRegExp = (value: string): string =>
  value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export interface ManagedBlockDefinition {
  end: string;
  start: string;
}

export interface ManagedBlockUpdate {
  changed: boolean;
  content: string;
}

/** Updates one generated section while preserving all user-owned content. */
export const updateManagedBlock = (
  existingContent: string,
  managedBlock: string,
  definition: ManagedBlockDefinition,
  header = '',
): ManagedBlockUpdate => {
  const startCount = existingContent.split(definition.start).length - 1;
  const endCount = existingContent.split(definition.end).length - 1;
  if (startCount !== endCount || startCount > 1) {
    throw new Error('Refusing to update malformed managed block');
  }

  const pattern = new RegExp(
    `${escapeRegExp(definition.start)}[\\s\\S]*?${escapeRegExp(definition.end)}`,
    'g',
  );
  let content: string;
  if (startCount === 1) {
    content = existingContent.replace(pattern, managedBlock);
  } else if (existingContent.trim().length === 0) {
    const prefix = header.trim().length === 0 ? '' : `${header.trimEnd()}\n\n`;
    content = `${prefix}${managedBlock}\n`;
  } else {
    content = `${managedBlock}\n\n${existingContent.trimStart()}`;
  }
  return { changed: content !== existingContent, content };
};

export const hasExactManagedBlock = (
  content: string,
  managedBlock: string,
  definition: ManagedBlockDefinition,
): boolean => {
  const pattern = new RegExp(
    `${escapeRegExp(definition.start)}[\\s\\S]*?${escapeRegExp(definition.end)}`,
    'g',
  );
  const blocks = content.match(pattern) ?? [];
  return blocks.length === 1 && blocks[0] === managedBlock;
};

/** Filled in CLIENT-02 from the 117-command inventory plus protocol-only methods. */
export const METHOD_NAMES = [] as const;

export type MethodName = (typeof METHOD_NAMES)[number];

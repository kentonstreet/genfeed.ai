/** Reserved server authorization proof never belongs in an outward execution payload. */
export function publicWorkflowExecutionValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(publicWorkflowExecutionValue);
  if (value === null || typeof value !== 'object' || value instanceof Date)
    return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(
        ([key]) =>
          ![
            'initiatingActor',
            'initiatingActorKey',
            'initiatingRequestKey',
          ].includes(key),
      )
      .map(([key, child]) => [key, publicWorkflowExecutionValue(child)]),
  );
}

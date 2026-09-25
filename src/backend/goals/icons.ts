// Sem dependências: o schema de comandos (domain/types) importa esta lista, e goals/types
// importa o schema de datas de lá. Deixar a lista em goals/types fecharia um ciclo.
export const GOAL_ICONS = [
  'target',
  'water',
  'book',
  'dumbbell',
  'run',
  'meditate',
  'sleep',
  'food',
  'heart',
  'star',
] as const;

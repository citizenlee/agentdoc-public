export type ParallelStrategy = 'single' | 'per-section' | 'orchestrated';

export interface OrchestrationConfig {
  singleWriter?: boolean;
}

export interface MechanicalPassConfig {
  id: string;
  enabled?: boolean;
}

export interface StaticFocusArea {
  id: string;
  name: string;
  systemPrompt: string;
}

export interface Skill {
  id: string;
  name: string;
  description: string;
  icon?: string;
  prompt: string;
  tools: string[];
  conflictsWith?: string[];
  parallelStrategy: ParallelStrategy;
  debugLoop?: string;
  maxAgents?: number;
  batchSize?: number;
  orchestratedVisibleMarks?: boolean;
  orchestration?: OrchestrationConfig;
  mechanicalPasses?: MechanicalPassConfig[];
  focusAreas?: StaticFocusArea[];
  styleGuideVersion?: string;
  styleGuideCharCount?: number;
  source?: 'builtin' | 'custom';
  filePath?: string;
}

export interface SkillRegistryConfig {
  skillsDirectory?: string;
  onSkillsChange?: (skills: Skill[]) => void;
}

const BUILTIN_SKILLS: Skill[] = [];

export class SkillsRegistry {
  private config: SkillRegistryConfig;
  private listeners = new Set<(skills: Skill[]) => void>();

  constructor(config: SkillRegistryConfig = {}) {
    this.config = config;
  }

  getSkill(id: string): Skill | undefined {
    return BUILTIN_SKILLS.find((skill) => skill.id === id);
  }

  getAllSkills(): Skill[] {
    return [...BUILTIN_SKILLS];
  }

  getBuiltinSkills(): Skill[] {
    return [...BUILTIN_SKILLS];
  }

  getCustomSkills(): Skill[] {
    return [];
  }

  getSkillCount(): number {
    return BUILTIN_SKILLS.length;
  }

  hasSkill(id: string): boolean {
    return BUILTIN_SKILLS.some((skill) => skill.id === id);
  }

  skillsConflict(skillAId: string, skillBId: string): boolean {
    const skillA = this.getSkill(skillAId);
    if (!skillA) return false;
    return Boolean(skillA.conflictsWith?.includes(skillBId));
  }

  getConflictingSkills(skillId: string): Skill[] {
    return this.getAllSkills().filter((skill) => this.skillsConflict(skillId, skill.id));
  }

  addCustomSkill(_skill: Skill): void {}

  removeCustomSkill(_skillId: string): boolean {
    return false;
  }

  clearCustomSkills(): void {}

  async loadCustomSkills(_forceRefresh = false): Promise<Skill[]> {
    return [];
  }

  onSkillsChange(callback: (skills: Skill[]) => void): () => void {
    this.listeners.add(callback);
    callback(this.getAllSkills());
    return () => {
      this.listeners.delete(callback);
    };
  }

  notifyChange(): void {
    const skills = this.getAllSkills();
    this.listeners.forEach((listener) => listener(skills));
    this.config.onSkillsChange?.(skills);
  }
}

let registry: SkillsRegistry | null = null;

export function initSkillsRegistry(config?: SkillRegistryConfig): SkillsRegistry {
  registry = new SkillsRegistry(config);
  return registry;
}

export function getSkillsRegistry(): SkillsRegistry {
  if (!registry) {
    registry = new SkillsRegistry();
  }
  return registry;
}

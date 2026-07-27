import type { DatabaseClient } from "../lib/supabase";
import { rowCountFrom, traceQuery } from "../lib/dbTrace";
import {
  assertData,
  mapDecision,
  mapPerson,
  mapRelationship,
  mapWorkflow,
  PERSON_CRM_COLS,
  RELATIONSHIP_COLS,
  WORKFLOW_CRM_COLS,
  type DecisionRecord,
  type Person,
  type RelationshipStage,
  type RelationshipState,
  type Workflow,
  type WorkflowState,
  type NextActionType,
} from "./shared";

export function createPersonRepository(db: DatabaseClient) {
  return {
    async list(): Promise<Person[]> {
      const { data, error } = await db
        .from("persons")
        .select("*")
        .order("created_at");
      return assertData(data, error, "PersonRepository.list").map((r) =>
        mapPerson(r as Record<string, unknown>),
      );
    },

    async getById(id: string): Promise<Person | null> {
      const { data, error } = await db
        .from("persons")
        .select("*")
        .eq("id", id)
        .maybeSingle();
      if (error) throw new Error(`PersonRepository.getById: ${error.message}`);
      return data ? mapPerson(data as Record<string, unknown>) : null;
    },

    async createPerson(input: {
      display_name: string;
      discover_meta?: Record<string, unknown>;
    }): Promise<Person> {
      const { data, error } = await db
        .from("persons")
        .insert({
          display_name: input.display_name,
          discover_meta: input.discover_meta ?? {},
        })
        .select("*")
        .single();
      return mapPerson(
        assertData(data, error, "PersonRepository.createPerson") as Record<
          string,
          unknown
        >,
      );
    },

    async upsertBlogIdentity(input: {
      person_id: string;
      blog_id: string;
      profile_snapshot?: Record<string, unknown>;
    }): Promise<void> {
      const { error } = await db.from("channel_identities").upsert(
        {
          person_id: input.person_id,
          channel: "blog",
          external_key: input.blog_id,
          profile_snapshot: input.profile_snapshot ?? {},
          state: {},
        },
        { onConflict: "channel,external_key" },
      );
      if (error) {
        throw new Error(
          `PersonRepository.upsertBlogIdentity: ${error.message}`,
        );
      }
    },

    async findPersonIdByBlogId(blogId: string): Promise<string | null> {
      const { data, error } = await db
        .from("channel_identities")
        .select("person_id")
        .eq("channel", "blog")
        .eq("external_key", blogId)
        .maybeSingle();
      if (error) {
        throw new Error(
          `PersonRepository.findPersonIdByBlogId: ${error.message}`,
        );
      }
      return data?.person_id ? String(data.person_id) : null;
    },

    async setActiveWorkflow(
      personId: string,
      workflowId: string,
    ): Promise<void> {
      const { error } = await db
        .from("persons")
        .update({ active_workflow_id: workflowId })
        .eq("id", personId);
      if (error)
        throw new Error(`PersonRepository.setActiveWorkflow: ${error.message}`);
    },

    async updateDiscoverMeta(
      personId: string,
      patch: Record<string, unknown>,
    ): Promise<Person> {
      const current = await this.getById(personId);
      if (!current)
        throw new Error(`PersonRepository.updateDiscoverMeta: not found`);
      const { data, error } = await db
        .from("persons")
        .update({
          discover_meta: { ...current.discover_meta, ...patch },
        })
        .eq("id", personId)
        .select("*")
        .single();
      return mapPerson(
        assertData(
          data,
          error,
          "PersonRepository.updateDiscoverMeta",
        ) as Record<string, unknown>,
      );
    },

    async getRelationship(personId: string): Promise<RelationshipState> {
      const { data, error } = await db
        .from("relationship_states")
        .select("*")
        .eq("person_id", personId)
        .single();
      return mapRelationship(
        assertData(data, error, "PersonRepository.getRelationship") as Record<
          string,
          unknown
        >,
      );
    },

    async updateRelationship(
      personId: string,
      patch: Partial<
        Pick<
          RelationshipState,
          | "stage"
          | "score"
          | "temperature"
          | "last_visit_at"
          | "last_like_at"
          | "last_comment_at"
          | "last_touch_at"
        >
      >,
    ): Promise<RelationshipState> {
      const { data, error } = await db
        .from("relationship_states")
        .update(patch)
        .eq("person_id", personId)
        .select("*")
        .single();
      return mapRelationship(
        assertData(
          data,
          error,
          "PersonRepository.updateRelationship",
        ) as Record<string, unknown>,
      );
    },

    async getActiveWorkflow(personId: string): Promise<Workflow | null> {
      const { data, error } = await db
        .from("workflows")
        .select("*")
        .eq("person_id", personId)
        .in("current_state", ["active", "waiting", "blocked"])
        .maybeSingle();
      if (error)
        throw new Error(`PersonRepository.getActiveWorkflow: ${error.message}`);
      return data ? mapWorkflow(data as Record<string, unknown>) : null;
    },

    async getWorkflow(id: string): Promise<Workflow> {
      const { data, error } = await db
        .from("workflows")
        .select("*")
        .eq("id", id)
        .single();
      return mapWorkflow(
        assertData(data, error, "PersonRepository.getWorkflow") as Record<
          string,
          unknown
        >,
      );
    },

    async createWorkflow(input: {
      person_id: string;
      current_stage: RelationshipStage;
      current_state: WorkflowState;
      next_action: NextActionType;
      last_decision_id: string | null;
      priority?: number;
      goal?: string | null;
    }): Promise<Workflow> {
      const { data, error } = await db
        .from("workflows")
        .insert({
          person_id: input.person_id,
          current_stage: input.current_stage,
          current_state: input.current_state,
          next_action: input.next_action,
          last_decision_id: input.last_decision_id,
          priority: input.priority ?? 0,
          goal: input.goal ?? null,
        })
        .select("*")
        .single();
      return mapWorkflow(
        assertData(data, error, "PersonRepository.createWorkflow") as Record<
          string,
          unknown
        >,
      );
    },

    async updateWorkflow(
      id: string,
      patch: Partial<{
        current_stage: RelationshipStage;
        current_state: WorkflowState;
        next_action: NextActionType;
        waiting_until: string | null;
        waiting_for: string | null;
        priority: number;
        blocked_reason: string | null;
        goal: string | null;
        last_decision_id: string | null;
      }>,
    ): Promise<Workflow> {
      const { data, error } = await db
        .from("workflows")
        .update(patch)
        .eq("id", id)
        .select("*")
        .single();
      return mapWorkflow(
        assertData(data, error, "PersonRepository.updateWorkflow") as Record<
          string,
          unknown
        >,
      );
    },

    async countWorkflowsByStages(stages: RelationshipStage[]): Promise<number> {
      const { count, error } = await traceQuery(
        "workflows.count_by_stages",
        () =>
          db
            .from("workflows")
            .select("id", { count: "exact", head: true })
            .in("current_stage", stages)
            .in("current_state", ["active", "waiting", "blocked"]),
        (r) => rowCountFrom(null, r.count),
      );
      if (error)
        throw new Error(
          `PersonRepository.countWorkflowsByStages: ${error.message}`,
        );
      return count ?? 0;
    },

    /** Single round-trip for Brief relationship KPI (replaces 2× countWorkflowsByStages). */
    async countActiveWorkflowGroups(): Promise<{
      newRelationships: number;
      maintaining: number;
    }> {
      const newStages: RelationshipStage[] = [
        "discover",
        "warming",
        "early_relationship",
      ];
      const maintainStages: RelationshipStage[] = ["maintain", "vip"];
      const { data, error } = await traceQuery(
        "workflows.count_stage_groups",
        () =>
          db
            .from("workflows")
            .select("current_stage")
            .in("current_state", ["active", "waiting", "blocked"]),
        (r) => rowCountFrom(r.data),
      );
      if (error) {
        throw new Error(
          `PersonRepository.countActiveWorkflowGroups: ${error.message}`,
        );
      }
      let newRelationships = 0;
      let maintaining = 0;
      for (const row of data ?? []) {
        const stage = String(row.current_stage) as RelationshipStage;
        if (newStages.includes(stage)) newRelationships += 1;
        if (maintainStages.includes(stage)) maintaining += 1;
      }
      return { newRelationships, maintaining };
    },

    async listActiveWorkflowPersonIds(): Promise<string[]> {
      const { data, error } = await db
        .from("workflows")
        .select("person_id")
        .in("current_state", ["active", "waiting", "blocked"]);
      if (error) {
        throw new Error(
          `PersonRepository.listActiveWorkflowPersonIds: ${error.message}`,
        );
      }
      return [...new Set((data ?? []).map((r) => String(r.person_id)))];
    },

    async listWorkflowsByPerson(personId: string): Promise<Workflow[]> {
      const { data, error } = await db
        .from("workflows")
        .select("*")
        .eq("person_id", personId)
        .order("updated_at", { ascending: false });
      return assertData(
        data,
        error,
        "PersonRepository.listWorkflowsByPerson",
      ).map((r) => mapWorkflow(r as Record<string, unknown>));
    },

    async listCrmRows(): Promise<
      Array<{
        person: Person;
        relationship: RelationshipState;
        workflow: Workflow | null;
      }>
    > {
      const personsRes = await traceQuery(
        "persons.list_crm",
        () => db.from("persons").select(PERSON_CRM_COLS).order("created_at"),
        (r) => rowCountFrom(r.data),
      );
      if (personsRes.error) {
        throw new Error(`PersonRepository.listCrmRows: ${personsRes.error.message}`);
      }
      const persons = (personsRes.data ?? []).map((r) =>
        mapPerson(r as Record<string, unknown>),
      );
      const personIds = persons.map((p) => p.id);
      if (personIds.length === 0) return [];

      const [relationshipsRes, workflowsRes] = await Promise.all([
        traceQuery(
          "relationship_states.by_person_ids",
          () =>
            db
              .from("relationship_states")
              .select(RELATIONSHIP_COLS)
              .in("person_id", personIds),
          (r) => rowCountFrom(r.data),
        ),
        traceQuery(
          "workflows.active_by_person_ids",
          () =>
            db
              .from("workflows")
              .select(WORKFLOW_CRM_COLS)
              .in("person_id", personIds)
              .in("current_state", ["active", "waiting", "blocked"]),
          (r) => rowCountFrom(r.data),
        ),
      ]);

      if (relationshipsRes.error) {
        throw new Error(
          `PersonRepository.listCrmRows: ${relationshipsRes.error.message}`,
        );
      }
      if (workflowsRes.error) {
        throw new Error(
          `PersonRepository.listCrmRows: ${workflowsRes.error.message}`,
        );
      }

      const relByPerson = new Map<string, RelationshipState>();
      for (const row of relationshipsRes.data ?? []) {
        relByPerson.set(
          String(row.person_id),
          mapRelationship(row as Record<string, unknown>),
        );
      }

      const wfByPerson = new Map<string, Workflow>();
      for (const row of workflowsRes.data ?? []) {
        const wf = mapWorkflow(row as Record<string, unknown>);
        const prev = wfByPerson.get(wf.person_id);
        if (!prev || wf.priority > prev.priority) {
          wfByPerson.set(wf.person_id, wf);
        }
      }

      const rows: Array<{
        person: Person;
        relationship: RelationshipState;
        workflow: Workflow | null;
      }> = [];

      for (const person of persons) {
        const relationship = relByPerson.get(person.id);
        if (!relationship) {
          console.warn(
            "[neighbor-sync-error] listCrmRows skip person",
            person.id,
            "missing relationship_states",
          );
          continue;
        }
        rows.push({
          person,
          relationship,
          workflow: wfByPerson.get(person.id) ?? null,
        });
      }
      return rows;
    },

    /** Read-only DecisionRecord consume for Supervisor Explain UI */
    async getDecisionById(id: string): Promise<DecisionRecord | null> {
      const { data, error } = await db
        .from("decision_records")
        .select("*")
        .eq("id", id)
        .maybeSingle();
      if (error)
        throw new Error(`PersonRepository.getDecisionById: ${error.message}`);
      return data ? mapDecision(data as Record<string, unknown>) : null;
    },

    async getDecisionsByIds(ids: string[]): Promise<DecisionRecord[]> {
      const unique = [...new Set(ids.filter(Boolean))];
      if (unique.length === 0) return [];
      const { data, error } = await db
        .from("decision_records")
        .select("*")
        .in("id", unique);
      return assertData(data, error, "PersonRepository.getDecisionsByIds").map(
        (r) => mapDecision(r as Record<string, unknown>),
      );
    },

    async listRecentDecisionsByPerson(
      personId: string,
      limit = 30,
    ): Promise<DecisionRecord[]> {
      const { data, error } = await db
        .from("decision_records")
        .select("*")
        .eq("person_id", personId)
        .order("created_at", { ascending: false })
        .limit(limit);
      return assertData(
        data,
        error,
        "PersonRepository.listRecentDecisionsByPerson",
      ).map((r) => mapDecision(r as Record<string, unknown>));
    },
  };
}

export type PersonRepository = ReturnType<typeof createPersonRepository>;

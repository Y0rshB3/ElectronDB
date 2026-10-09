import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import type {
  Job,
  JobInput,
  JobPackageSummary,
  JobRun,
  RollbackRequest,
  WriteOptions
} from '@shared/types'
import { api } from '@renderer/api'

export const useJobsStore = defineStore('jobs', () => {
  const jobs = ref<Job[]>([])
  const runs = ref<JobRun[]>([])
  const loaded = ref(false)
  const loading = ref(false)
  /** Latest package of every job with copies (jobs:packages); empty until loadPackages(). */
  const packages = ref<JobPackageSummary[]>([])
  const packagesLoaded = ref(false)

  const sorted = computed(() => [...jobs.value].sort((a, b) => a.name.localeCompare(b.name, 'es')))
  /**
   * Active run of each job. A rollback («Restaurar todo») is listed in the
   * job's history but is not a run of the job: it never marks it as running.
   */
  const runningByJob = computed(() => {
    const map = new Map<string, JobRun>()
    for (const run of runs.value)
      if ((run.status === 'running' || run.status === 'queued') && run.kind !== 'rollback')
        map.set(run.jobId, run)
    return map
  })

  function get(id: string): Job | undefined {
    return jobs.value.find((j) => j.id === id)
  }

  /** Last run of the job itself (its status pill); rollbacks of its copies do not count. */
  function lastRunOf(jobId: string): JobRun | undefined {
    return runs.value
      .filter((r) => r.jobId === jobId && r.kind !== 'rollback')
      .sort((a, b) => b.startedAt.localeCompare(a.startedAt))[0]
  }

  function runsOf(jobId: string): JobRun[] {
    return runs.value
      .filter((r) => r.jobId === jobId)
      .sort((a, b) => b.startedAt.localeCompare(a.startedAt))
  }

  async function load(): Promise<void> {
    loading.value = true
    try {
      const [list, recent] = await Promise.all([api.jobs.list(), api.jobs.runs(null, 200)])
      jobs.value = list
      runs.value = recent
      loaded.value = true
    } finally {
      loading.value = false
    }
  }

  /** Refreshes the job packages; a failure keeps the previous list (the list is a helper). */
  async function loadPackages(): Promise<JobPackageSummary[]> {
    try {
      const list = await api.jobs.packages()
      packages.value = Array.isArray(list) ? list : []
      packagesLoaded.value = true
    } catch {
      /* invokeSilent: the editor shows the jobs without their packages */
    }
    return packages.value
  }

  function packageOf(jobId: string): JobPackageSummary | undefined {
    return packages.value.find((p) => p.jobId === jobId)
  }

  async function loadRuns(jobId: string, limit = 50): Promise<JobRun[]> {
    const list = await api.jobs.runs(jobId, limit)
    for (const run of list) upsertRun(run)
    return runsOf(jobId)
  }

  async function save(input: JobInput, options?: WriteOptions): Promise<Job> {
    const saved = await (options ? api.jobs.save(input, options) : api.jobs.save(input))
    const idx = jobs.value.findIndex((j) => j.id === saved.id)
    if (idx >= 0) jobs.value.splice(idx, 1, saved)
    else jobs.value.push(saved)
    return saved
  }

  async function remove(id: string): Promise<void> {
    await api.jobs.delete(id)
    jobs.value = jobs.value.filter((j) => j.id !== id)
  }

  async function run(id: string, options?: WriteOptions): Promise<JobRun> {
    const jobRun = await (options ? api.jobs.run(id, options) : api.jobs.run(id))
    upsertRun(jobRun)
    return jobRun
  }

  /** «Restaurar todo»: starts the rollback run (errors are left to the caller's dialog). */
  async function rollback(request: RollbackRequest, options?: WriteOptions): Promise<JobRun> {
    const jobRun = await (options
      ? api.jobs.rollback(request, options)
      : api.jobs.rollback(request))
    upsertRun(jobRun)
    return jobRun
  }

  async function cancel(runId: string): Promise<void> {
    await api.jobs.cancel(runId)
  }

  function upsertRun(jobRun: JobRun): void {
    const idx = runs.value.findIndex((r) => r.id === jobRun.id)
    if (idx >= 0) runs.value.splice(idx, 1, jobRun)
    else runs.value.unshift(jobRun)
    if (runs.value.length > 500) runs.value.splice(500)
    const job = get(jobRun.jobId)
    // A rollback restores another run's backups: the job itself did not run.
    if (job && jobRun.finishedAt && jobRun.kind !== 'rollback') job.lastRunAt = jobRun.finishedAt
  }

  function listen(): () => void {
    return api.on('event:jobRun', upsertRun)
  }

  return {
    jobs,
    runs,
    loaded,
    loading,
    sorted,
    runningByJob,
    get,
    lastRunOf,
    runsOf,
    load,
    loadRuns,
    save,
    remove,
    run,
    rollback,
    cancel,
    upsertRun,
    listen,
    packages,
    packagesLoaded,
    loadPackages,
    packageOf
  }
})

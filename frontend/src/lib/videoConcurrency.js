export const MAX_CONCURRENT_VIDEO_REQUESTS = 10

export const activeVideoRequestCount = (videoJobs = {}) =>
  Object.values(videoJobs).filter(job => job?.jobId && job.status === 'pending').length

export const availableVideoRequestSlots = (
  videoJobs = {},
  maximum = MAX_CONCURRENT_VIDEO_REQUESTS
) => Math.max(0, maximum - activeVideoRequestCount(videoJobs))

export const queuedVideoUnitIds = (videoProgress = {}, videoJobs = {}) =>
  (videoProgress.pending || []).filter(unitId => {
    const job = videoJobs[unitId]
    return !(job?.jobId && job.status === 'pending')
  })

export const takeVideoSubmissionSlots = (
  scenes = [],
  videoJobs = {},
  maximum = MAX_CONCURRENT_VIDEO_REQUESTS
) => scenes.slice(0, availableVideoRequestSlots(videoJobs, maximum))

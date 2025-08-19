<!-- src/components/LogTable.vue -->
<template>
  <div class="log-table-container">
    <table v-if="logs && logs.length > 0">
      <thead>
        <tr>
          <th>Timestamp</th>
          <th>Status</th>
          <th>Response Time</th>
          <th>Stream</th>
          <th>Request URL</th>
          <th>Request Model</th>
          <th>Input Tokens</th>
          <th>Output Tokens</th>
          <th>Error</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="log in logs" :key="log.id">
          <td>{{ new Date(log.requestTimestamp).toLocaleString() }}</td>
          <td>
            <span :class="statusClass(log.statusCode)">{{ log.statusCode }}</span>
          </td>
          <td>{{ log.responseTimeMs }}ms</td>
          <td>{{ log.isStream ? 'Yes' : 'No' }}</td>
          <td class="url-cell" :title="log.requestUrl">{{ log.requestUrl }}</td>
          <td>{{ log.requestModel }}</td>
          <td>{{ log.inputTokens || '-' }}</td>
          <td>{{ log.outputTokens || '-' }}</td>
          <td class="error-cell" :title="log.errorMessage">{{ log.errorMessage }}</td>
        </tr>
      </tbody>
    </table>
    <div v-else class="no-logs">
      <p>No logs to display. Enter your key and click "Fetch Logs".</p>
    </div>
  </div>
</template>

<script setup>
defineProps({
  logs: {
    type: Array,
    default: () => [],
  },
});

const statusClass = (statusCode) => {
  if (statusCode >= 500) return 'status-error';
  if (statusCode >= 400) return 'status-warn';
  if (statusCode >= 200 && statusCode < 300) return 'status-success';
  return '';
};
</script>

<style scoped>
.log-table-container {
  overflow-x: auto;
}
table {
  width: 100%;
  border-collapse: collapse;
  margin-top: 1rem;
}
th, td {
  padding: 0.75rem;
  text-align: left;
  border-bottom: 1px solid #ddd;
  white-space: nowrap;
}
th {
  background-color: #f4f4f4;
}
.status-success {
  color: green;
  font-weight: bold;
}
.status-warn {
  color: orange;
  font-weight: bold;
}
.status-error {
  color: red;
  font-weight: bold;
}
.error-cell {
  max-width: 200px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  cursor: help;
}
.url-cell {
  max-width: 150px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  cursor: help;
}
.no-logs {
  text-align: center;
  margin-top: 2rem;
  color: #666;
}
</style>

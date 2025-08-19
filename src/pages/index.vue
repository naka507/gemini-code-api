<!-- src/pages/index.vue -->
<template>
  <div class="container">
    <header>
      <h1>Gemini Code API</h1>
      <p>The intelligent Gemini API gateway.</p>
    </header>
    <main>
      <div class="input-group">
        <input v-model="apiKey" type="password" placeholder="Enter your API Key to view logs" @keyup.enter="fetchLogs" />
        <button @click="fetchLogs" :disabled="loading">
          <span v-if="loading">Loading...</span>
          <span v-else>Fetch Logs</span>
        </button>
      </div>
      <div v-if="error" class="error-message">
        {{ error }}
      </div>
      <LogTable :logs="logs" />
    </main>
  </div>
</template>

<script setup>
import { ref } from 'vue';
import LogTable from '~/components/LogTable.vue';

const apiKey = ref('');
const logs = ref([]);
const loading = ref(false);
const error = ref(null);

const fetchLogs = async () => {
  if (!apiKey.value) {
    error.value = 'Please enter an API key.';
    return;
  }
  loading.value = true;
  error.value = null;
  logs.value = [];

  try {
    const response = await $fetch('/logs', {
      query: { apiKey: apiKey.value },
    });
    if (response.logs.length === 0) {
      error.value = 'No logs found for this API key.';
    }
    logs.value = response.logs;
  } catch (e) {
    error.value = e.data?.statusMessage || 'An error occurred while fetching logs.';
    console.error(e);
  } finally {
    loading.value = false;
  }
};
</script>

<style scoped>
.container {
  max-width: 1200px;
  margin: 0 auto;
  padding: 2rem;
  font-family: sans-serif;
}
header {
  text-align: center;
  margin-bottom: 2rem;
}
.input-group {
  display: flex;
  margin-bottom: 1rem;
}
input {
  flex-grow: 1;
  padding: 0.5rem;
  font-size: 1rem;
}
button {
  padding: 0.5rem 1rem;
  font-size: 1rem;
  cursor: pointer;
}
.error-message {
  color: red;
  margin-bottom: 1rem;
}
</style>

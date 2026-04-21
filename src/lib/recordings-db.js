const DB_NAME = "audio-off-air-logger";
const STORE_NAME = "recordings";
const DB_VERSION = 1;

function openDatabase() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = () => {
      const database = request.result;

      if (!database.objectStoreNames.contains(STORE_NAME)) {
        const store = database.createObjectStore(STORE_NAME, { keyPath: "id" });
        store.createIndex("createdAt", "createdAt", { unique: false });
      }
    };

    request.onsuccess = () => {
      resolve(request.result);
    };

    request.onerror = () => {
      reject(request.error);
    };
  });
}

function waitForTransaction(transaction) {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error);
  });
}

function runRequest(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export async function saveRecording(entry) {
  const database = await openDatabase();
  const transaction = database.transaction(STORE_NAME, "readwrite");
  const store = transaction.objectStore(STORE_NAME);

  await runRequest(store.put(entry));
  await waitForTransaction(transaction);
}

export async function getAllRecordings() {
  const database = await openDatabase();
  const transaction = database.transaction(STORE_NAME, "readonly");
  const store = transaction.objectStore(STORE_NAME);
  const results = await runRequest(store.getAll());

  await waitForTransaction(transaction);

  return results
    .map(({ blob, ...metadata }) => metadata)
    .sort((left, right) => new Date(right.createdAt) - new Date(left.createdAt));
}

export async function getRecordingById(id) {
  const database = await openDatabase();
  const transaction = database.transaction(STORE_NAME, "readonly");
  const store = transaction.objectStore(STORE_NAME);
  const result = await runRequest(store.get(id));

  await waitForTransaction(transaction);

  return result ?? null;
}

export async function deleteRecordingById(id) {
  const database = await openDatabase();
  const transaction = database.transaction(STORE_NAME, "readwrite");
  const store = transaction.objectStore(STORE_NAME);

  await runRequest(store.delete(id));
  await waitForTransaction(transaction);
}

export async function clearAllRecordings() {
  const database = await openDatabase();
  const transaction = database.transaction(STORE_NAME, "readwrite");
  const store = transaction.objectStore(STORE_NAME);

  await runRequest(store.clear());
  await waitForTransaction(transaction);
}

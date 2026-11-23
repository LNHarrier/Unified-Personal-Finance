import { useCallback, useEffect, useState } from "react";
import { AppState, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import * as Crypto from "expo-crypto";
import * as Network from "expo-network";
import * as SecureStore from "expo-secure-store";
import {
  discardOfflineOperation,
  enqueueOfflineOperation,
  getOfflineReferenceData,
  listOfflineOperations,
  saveOfflineReferenceData,
  syncOfflineOperations,
  type OfflineOperation,
} from "../../src/offlineSync.js";

const API_URL = process.env.EXPO_PUBLIC_API_URL ?? "http://10.0.2.2:3001";
type Account = { id: string; name: string; currency: string; account_type: string };
type Transaction = { id: string; transaction_type: string; amount_minor: number; description?: string };

export default function Transactions() {
  const [transactions, setTransactions] = useState<Transaction[]>([]);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [offlineOperations, setOfflineOperations] = useState<OfflineOperation[]>([]);
  const [userId, setUserId] = useState("");
  const [kind, setKind] = useState<"expense" | "income" | "transfer">("expense");
  const [accountId, setAccountId] = useState("");
  const [toAccountId, setToAccountId] = useState("");
  const [amount, setAmount] = useState("");
  const [description, setDescription] = useState("");
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [isOnline, setIsOnline] = useState<boolean | null>(null);

  const refresh = useCallback(async () => {
    const token = await SecureStore.getItemAsync("upf_token");
    if (!token) return;
    try {
      const network = await Network.getNetworkStateAsync();
      const online = Boolean(network.isConnected) && network.isInternetReachable !== false;
      setIsOnline(online);
      let activeUserId = await SecureStore.getItemAsync("upf_user_id");
      if (!activeUserId && online) {
        const profileResponse = await fetch(`${API_URL}/api/v1/users/me`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (!profileResponse.ok) throw new Error("Unable to identify the signed-in account for offline sync.");
        const profile = await profileResponse.json();
        const profileUserId: unknown = profile.user?.id;
        if (typeof profileUserId !== "string" || !profileUserId) throw new Error("The signed-in account profile is invalid.");
        activeUserId = profileUserId;
        await SecureStore.setItemAsync("upf_user_id", profileUserId);
      }
      if (activeUserId) {
        setUserId(activeUserId);
        if (online) await syncOfflineOperations(token, activeUserId);
        setOfflineOperations(await listOfflineOperations(activeUserId));
        if (!online) {
          const cached = await getOfflineReferenceData(activeUserId);
          setAccounts(cached.accounts as Account[]);
        }
      }
      if (!online) {
        setError("");
        return;
      }
      const headers = { Authorization: `Bearer ${token}` };
      const [transactionResponse, accountResponse] = await Promise.all([
        fetch(`${API_URL}/api/v1/transactions`, { headers }),
        fetch(`${API_URL}/api/v1/accounts`, { headers }),
      ]);
      if (!transactionResponse.ok || !accountResponse.ok) throw new Error("Unable to load financial data.");
      const transactionData = await transactionResponse.json();
      const accountData = await accountResponse.json();
      setTransactions(transactionData.items);
      setAccounts(accountData.items);
      if (activeUserId) {
        const cached = await getOfflineReferenceData(activeUserId);
        await saveOfflineReferenceData(activeUserId,accountData.items,cached.categories);
      }
      setAccountId((current) => current || accountData.items[0]?.id || "");
      setToAccountId((current) => current || accountData.items[1]?.id || "");
      setError("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unable to load transactions.");
    }
  }, []);

  useEffect(() => {
    void refresh();
    const networkSubscription = Network.addNetworkStateListener((state) => {
      if (state.isConnected) void refresh();
      else setIsOnline(false);
    });
    const appStateSubscription = AppState.addEventListener("change", (state) => {
      if (state === "active") void refresh();
    });
    return () => {
      networkSubscription.remove();
      appStateSubscription.remove();
    };
  }, [refresh]);

  const save = async () => {
    setError("");
    setMessage("");
    try {
      const token = await SecureStore.getItemAsync("upf_token");
      const activeUserId = userId || await SecureStore.getItemAsync("upf_user_id");
      if (!token || !activeUserId) throw new Error("Sign in while online once before saving offline transactions.");
      const amountMinor = Math.round(Number(amount) * 100);
      if (!Number.isFinite(amountMinor) || amountMinor <= 0) throw new Error("Enter an amount greater than zero.");
      const key = Crypto.randomUUID();
      const currency = accounts.find((account) => account.id === accountId)?.currency ?? "INR";
      const operationType = kind === "transfer" ? "transfer" : "transaction";
      const payload = kind === "transfer"
        ? { fromAccountId: accountId, toAccountId, amountMinor, currency, description, idempotencyKey: key }
        : { transactionType: kind, accountId, amountMinor, currency, description, transactionAt: new Date().toISOString(), idempotencyKey: key };
      await enqueueOfflineOperation(activeUserId, operationType, payload);
      setUserId(activeUserId);
      setAmount("");
      setDescription("");
      try {
        await syncOfflineOperations(token, activeUserId);
        const remaining = await listOfflineOperations(activeUserId);
        setOfflineOperations(remaining);
        setMessage(remaining.some((item) => item.id === key)
          ? "Saved securely on this device. It will sync when a connection is available."
          : "Saved and synchronized.");
      } catch {
        setOfflineOperations(await listOfflineOperations(activeUserId));
        setMessage("Saved securely on this device. Synchronization will retry when possible.");
      }
      await refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Transaction could not be saved.");
    }
  };

  const discardFailed = async (operationId: string) => {
    try {
      await discardOfflineOperation(userId, operationId);
      setOfflineOperations(await listOfflineOperations(userId));
      setError("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not discard the failed operation.");
    }
  };

  const selectedCurrency = accounts.find((account) => account.id === accountId)?.currency ?? "INR";
  return (
    <SafeAreaView style={styles.safe}>
      <Text style={styles.title}>Transactions</Text>
      <Text style={styles.connection}>{isOnline === false ? "Offline · changes are encrypted and queued" : "Online sync enabled"}</Text>
      <View style={styles.form}>
        <View style={styles.row}>{(["expense","income","transfer"] as const).map((value) => <Pressable key={value} onPress={() => setKind(value)} style={[styles.chip,kind===value&&styles.selected]}><Text style={kind===value?styles.selectedText:styles.chipText}>{value}</Text></Pressable>)}</View>
        <Text style={styles.label}>From account</Text>
        <View style={styles.row}>{accounts.map((account) => <Pressable key={account.id} onPress={() => setAccountId(account.id)} style={[styles.chip,accountId===account.id&&styles.selected]}><Text style={accountId===account.id?styles.selectedText:styles.chipText}>{account.name}</Text></Pressable>)}</View>
        {kind === "transfer" && <>
          <Text style={styles.label}>To account</Text>
          <View style={styles.row}>{accounts.filter((account) => account.id !== accountId).map((account) => <Pressable key={account.id} onPress={() => setToAccountId(account.id)} style={[styles.chip,toAccountId===account.id&&styles.selected]}><Text style={toAccountId===account.id?styles.selectedText:styles.chipText}>{account.name}</Text></Pressable>)}</View>
        </>}
        <TextInput placeholder={`Amount (${selectedCurrency})`} value={amount} onChangeText={setAmount} keyboardType="decimal-pad" style={styles.input} />
        <TextInput placeholder="Description" value={description} onChangeText={setDescription} style={styles.input} />
        {error ? <Text style={styles.error} accessibilityRole="alert">{error}</Text> : null}
        {message ? <Text style={styles.message}>{message}</Text> : null}
        <Pressable style={styles.button} onPress={save}><Text style={styles.buttonText}>Save {kind}</Text></Pressable>
      </View>
      {offlineOperations.length > 0 && <View style={styles.outbox}>
        <View style={styles.outboxHeader}>
          <Text style={styles.outboxTitle}>Pending device sync ({offlineOperations.length})</Text>
          <Pressable onPress={() => void refresh()}><Text style={styles.link}>Sync now</Text></Pressable>
        </View>
        {offlineOperations.map((operation) => <View key={operation.id} style={styles.operation}>
          <View style={styles.operationText}>
            <Text style={styles.name}>{operation.payload.description || operation.operation_type}</Text>
            <Text style={styles.detail}>{operation.status === "failed" ? operation.last_error : "Waiting to synchronize"}</Text>
          </View>
          {operation.payload.amountMinor !== undefined && <Text style={styles.amount}>{(operation.payload.amountMinor / 100).toLocaleString("en-IN", { style: "currency", currency: selectedCurrency })}</Text>}
          {operation.status === "failed" && <Pressable onPress={() => void discardFailed(operation.id)}><Text style={styles.error}>Discard</Text></Pressable>}
        </View>)}
      </View>}
      <ScrollView>{transactions.map((item) => <View key={item.id} style={styles.card}><Text style={styles.name}>{item.description ?? item.transaction_type}</Text><Text style={styles.amount}>₹{(item.amount_minor / 100).toLocaleString("en-IN")}</Text></View>)}</ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: "#f4f7f4", padding: 18 },
  title: { fontSize: 30, fontWeight: "800", color: "#17332a", marginBottom: 4 },
  connection: { color: "#718078", marginBottom: 12 },
  card: { backgroundColor: "white", borderRadius: 14, padding: 16, marginBottom: 10, borderWidth: 1, borderColor: "#e5ebe7", flexDirection: "row", justifyContent: "space-between" },
  name: { color: "#17332a", fontWeight: "700" },
  amount: { color: "#1f8059", fontWeight: "800" },
  form: { backgroundColor:"white",borderRadius:14,padding:14,marginBottom:14,borderWidth:1,borderColor:"#e5ebe7",gap:9 },
  row: { flexDirection:"row",flexWrap:"wrap",gap:6 },
  chip: { paddingVertical:7,paddingHorizontal:9,borderRadius:18,backgroundColor:"#edf1ee" },
  selected: { backgroundColor:"#1f8059" },
  chipText: { color:"#52655c",fontSize:12 },
  selectedText: { color:"white",fontSize:12 },
  label: { color:"#596962",fontWeight:"700" },
  input: { borderWidth:1,borderColor:"#d8e1dc",borderRadius:9,padding:11 },
  button: { backgroundColor:"#1f8059",borderRadius:9,padding:12,alignItems:"center" },
  buttonText: { color:"white",fontWeight:"800" },
  error: { color:"#b33a34" },
  message: { color: "#1f8059" },
  outbox: { backgroundColor: "white", borderRadius: 14, padding: 14, marginBottom: 14, borderWidth: 1, borderColor: "#e5ebe7" },
  outboxHeader: { flexDirection: "row", justifyContent: "space-between", marginBottom: 8 },
  outboxTitle: { color: "#17332a", fontWeight: "800" },
  link: { color: "#1f8059", fontWeight: "700" },
  operation: { borderTopWidth: 1, borderTopColor: "#e5ebe7", paddingVertical: 9, flexDirection: "row", alignItems: "center", gap: 8 },
  operationText: { flex: 1 },
  detail: { color: "#718078", fontSize: 12, marginTop: 3 },
});

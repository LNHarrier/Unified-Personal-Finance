import { useCallback, useEffect, useMemo, useState } from "react";
import { AppState, Pressable, ScrollView, StyleSheet, Switch, Text, TextInput, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import * as Crypto from "expo-crypto";
import * as Network from "expo-network";
import * as SecureStore from "expo-secure-store";
import {
  discardOfflineOperation,
  discardOfflineOperations,
  enqueueOfflineOperation,
  getDeviceId,
  getOfflineReferenceData,
  listOfflineOperations,
  saveOfflineReferenceData,
  syncOfflineOperations,
  type OfflineOperation,
} from "../../src/offlineSync.js";
import { notificationCapture, type NotificationCandidate } from "../../src/notificationCapture.js";

const API_URL = process.env.EXPO_PUBLIC_API_URL ?? "http://10.0.2.2:3001";
type Account = { id: string; name: string; account_type: string; currency: string };
type Category = { id: string; name: string; category_type: "income" | "expense" };

function money(minor: number, currency: string) {
  return new Intl.NumberFormat("en-IN", { style: "currency", currency }).format(minor / 100);
}

export default function Settings() {
  const [available, setAvailable] = useState(Boolean(notificationCapture));
  const [enabled, setEnabled] = useState(false);
  const [accessGranted, setAccessGranted] = useState(false);
  const [candidates, setCandidates] = useState<NotificationCandidate[]>([]);
  const [operations, setOperations] = useState<OfflineOperation[]>([]);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [categories, setCategories] = useState<Category[]>([]);
  const [selectedCandidate, setSelectedCandidate] = useState<NotificationCandidate | null>(null);
  const [accountId, setAccountId] = useState("");
  const [categoryId, setCategoryId] = useState("");
  const [amount, setAmount] = useState("");
  const [description, setDescription] = useState("");
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [saving, setSaving] = useState(false);

  const candidateAccounts = useMemo(() => selectedCandidate
    ? accounts.filter((account) => ["bank", "cash", "credit_card"].includes(account.account_type)
      && account.currency === selectedCandidate.currency)
    : [], [accounts, selectedCandidate]);
  const candidateCategories = useMemo(() => categories.filter((category) =>
    category.category_type === selectedCandidate?.direction), [categories, selectedCandidate]);

  const refresh = useCallback(async () => {
    setError("");
    try {
      if (!notificationCapture) {
        setAvailable(false);
        return;
      }
      const [captureEnabled, granted, localCandidates] = await Promise.all([
        notificationCapture.isCaptureEnabled(),
        notificationCapture.hasNotificationAccess(),
        notificationCapture.getCandidates(),
      ]);
      setAvailable(true);
      setEnabled(captureEnabled);
      setAccessGranted(granted);
      setCandidates(localCandidates);
      const token = await SecureStore.getItemAsync("upf_token");
      const userId = await SecureStore.getItemAsync("upf_user_id");
      if (!token || !userId) return;
      const network = await Network.getNetworkStateAsync();
      if (!network.isConnected || network.isInternetReachable === false) {
        const cached = await getOfflineReferenceData(userId);
        setAccounts(cached.accounts as Account[]);
        setCategories(cached.categories as Category[]);
        setOperations((await listOfflineOperations(userId)).filter((item) =>
          item.operation_type === "notification_confirmation" || item.operation_type === "notification_delete"));
        return;
      }
      const [accountResponse, categoryResponse] = await Promise.all([
        fetch(`${API_URL}/api/v1/accounts`, { headers: { Authorization: `Bearer ${token}` } }),
        fetch(`${API_URL}/api/v1/categories`, { headers: { Authorization: `Bearer ${token}` } }),
      ]);
      if (!accountResponse.ok || !categoryResponse.ok) throw new Error("Unable to load accounts and categories for review.");
      const accountData = await accountResponse.json();
      const categoryData = await categoryResponse.json();
      setAccounts(accountData.items);
      setCategories(categoryData.items);
      await saveOfflineReferenceData(userId,accountData.items,categoryData.items);
      await syncOfflineOperations(token,userId);
      setCandidates(await notificationCapture.getCandidates());
      setOperations((await listOfflineOperations(userId)).filter((item) =>
        item.operation_type === "notification_confirmation" || item.operation_type === "notification_delete"));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not load notification capture settings.");
    }
  }, []);

  useEffect(() => {
    void refresh();
    const subscription = AppState.addEventListener("change", (state) => {
      if (state === "active") void refresh();
    });
    const networkSubscription = Network.addNetworkStateListener((state) => {
      if (state.isConnected) void refresh();
    });
    return () => {
      subscription.remove();
      networkSubscription.remove();
    };
  }, [refresh]);

  const setCapture = async (value: boolean) => {
    setError("");
    setMessage("");
    try {
      if (!notificationCapture) throw new Error("Notification capture requires the installed Finova Android build.");
      await notificationCapture.setCaptureEnabled(value);
      setEnabled(value);
      if (!value) {
        setCandidates([]);
        setSelectedCandidate(null);
        setMessage("Capture disabled. Unreviewed device candidates were deleted.");
      } else {
        setMessage("Capture is on. Allow Finova in Android notification access settings to start collecting candidates.");
        await notificationCapture.openNotificationSettings();
      }
      await refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not update notification capture.");
    }
  };

  const reviewCandidate = (candidate: NotificationCandidate) => {
    setSelectedCandidate(candidate);
    setAmount((candidate.amountMinor / 100).toFixed(2));
    setDescription(candidate.description);
    setAccountId(accounts.find((account) =>
      ["bank", "cash", "credit_card"].includes(account.account_type)
      && account.currency === candidate.currency)?.id ?? "");
    setCategoryId("");
    setError("");
  };

  const confirmCandidate = async () => {
    if (!selectedCandidate) return;
    setError("");
    setMessage("");
    setSaving(true);
    try {
      const token = await SecureStore.getItemAsync("upf_token");
      const userId = await SecureStore.getItemAsync("upf_user_id");
      if (!token || !userId) throw new Error("Sign in again before confirming a notification candidate.");
      const selectedAccount = candidateAccounts.find((item) => item.id === accountId);
      if (!selectedAccount) throw new Error("Choose a valid account in the candidate's currency.");
      const amountMinor = Math.round(Number(amount) * 100);
      if (!Number.isSafeInteger(amountMinor) || amountMinor <= 0) throw new Error("Enter a valid amount greater than zero.");
      const idempotencyKey = Crypto.randomUUID();
      await enqueueOfflineOperation(userId,"notification_confirmation",{
        candidateId: selectedCandidate.candidateId,
        deviceId: await getDeviceId(),
        sourcePackage: selectedCandidate.sourcePackage,
        receivedAt: selectedCandidate.receivedAt,
        amountMinor,
        currency: selectedAccount.currency,
        direction: selectedCandidate.direction,
        description: description.trim() || "Payment notification",
        referenceHash: selectedCandidate.referenceHash,
        accountId,
        ...(categoryId ? { categoryId } : {}),
        idempotencyKey,
      });
      setSelectedCandidate(null);
      await syncOfflineOperations(token,userId);
      await refresh();
      setMessage("Confirmed. It was posted or queued securely for synchronization.");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not confirm candidate.");
    } finally {
      setSaving(false);
    }
  };

  const ignoreCandidate = async (candidateId: string) => {
    try {
      await notificationCapture?.removeCandidate(candidateId);
      setCandidates(await notificationCapture?.getCandidates() ?? []);
      if (selectedCandidate?.candidateId === candidateId) setSelectedCandidate(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not delete the candidate.");
    }
  };

  const discardOperation = async (operationId: string) => {
    try {
      const userId = await SecureStore.getItemAsync("upf_user_id");
      if (!userId) return;
      await discardOfflineOperation(userId,operationId);
      setOperations((await listOfflineOperations(userId)).filter((item) => item.operation_type === "notification_confirmation"));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not discard the failed confirmation.");
    }
  };

  const deleteAllNotificationData = async () => {
    setError("");
    setMessage("");
    try {
      if (!notificationCapture) throw new Error("Notification capture requires the installed Finova Android build.");
      const token = await SecureStore.getItemAsync("upf_token");
      const userId = await SecureStore.getItemAsync("upf_user_id");
      if (!token || !userId) throw new Error("Sign in again before deleting captured notification data.");
      await notificationCapture.clearCandidates();
      await discardOfflineOperations(userId,"notification_confirmation");
      const idempotencyKey = Crypto.randomUUID();
      await enqueueOfflineOperation(userId,"notification_delete",{ idempotencyKey });
      await syncOfflineOperations(token,userId);
      setCandidates([]);
      setOperations((await listOfflineOperations(userId)).filter((item) =>
        item.operation_type === "notification_confirmation" || item.operation_type === "notification_delete"));
      setMessage("Local candidates were deleted. Server capture records were removed or queued for deletion; posted transactions remain in your ledger.");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not delete captured notification data.");
    }
  };

  return (
    <SafeAreaView style={styles.safe}>
      <ScrollView contentContainerStyle={styles.content}>
        <Text style={styles.title}>Settings</Text>
        <View style={styles.card}>
          <Text style={styles.heading}>Payment notification capture</Text>
          <Text style={styles.body}>
            Optional Android notification access reads notifications only from supported payment apps (Google Pay, Paytm, and PhonePe). Parsing happens on this device. Raw notification text is never stored or uploaded; only a minimal encrypted candidate is kept locally. A candidate is never posted until you review and confirm it.
          </Text>
          {!available && <Text style={styles.error}>Install the Finova Android development build; Expo Go does not include the native notification listener.</Text>}
          {available && <View style={styles.switchRow}>
            <Text style={styles.label}>Enable capture</Text>
            <Switch value={enabled} onValueChange={(value) => void setCapture(value)} />
          </View>}
          {available && enabled && <Text style={accessGranted ? styles.success : styles.warning}>
            {accessGranted ? "Android notification access is granted." : "Allow notification access in Android Settings to enable capture."}
          </Text>}
          <Text style={styles.body}>Disable capture to delete unreviewed local candidates. Captured candidate data expires after 30 days. Posted ledger transactions remain unchanged.</Text>
          {available && <Pressable style={styles.secondaryButton} onPress={() => void deleteAllNotificationData()}>
            <Text style={styles.secondaryText}>Delete all captured notification data</Text>
          </Pressable>}
        </View>

        {error ? <Text style={styles.error} accessibilityRole="alert">{error}</Text> : null}
        {message ? <Text style={styles.success}>{message}</Text> : null}

        <View style={styles.card}>
          <Text style={styles.heading}>Captured candidates ({candidates.length})</Text>
          {!enabled && <Text style={styles.body}>Turn on capture and grant Android notification access to collect candidates.</Text>}
          {candidates.map((candidate) => {
            const queued = operations.find((operation) => operation.payload.candidateId === candidate.candidateId);
            return <View style={styles.candidate} key={candidate.candidateId}>
              <View style={styles.candidateText}>
                <Text style={styles.label}>{candidate.description} · {candidate.direction}</Text>
                <Text style={styles.body}>{money(candidate.amountMinor,candidate.currency)} · {new Date(candidate.receivedAt).toLocaleString()}</Text>
                {queued?.status === "pending" && <Text style={styles.warning}>Confirmed, waiting to sync</Text>}
                {queued?.status === "failed" && <Text style={styles.error}>{queued.last_error}</Text>}
              </View>
              {queued?.status === "failed"
                ? <Pressable onPress={() => void discardOperation(queued.id)}><Text style={styles.danger}>Discard</Text></Pressable>
                : queued ? null : <Pressable onPress={() => reviewCandidate(candidate)}><Text style={styles.link}>Review</Text></Pressable>}
              {!queued && <Pressable onPress={() => void ignoreCandidate(candidate.candidateId)}><Text style={styles.danger}>Ignore</Text></Pressable>}
            </View>;
          })}
          {operations.filter((operation) => operation.operation_type === "notification_delete").map((operation) => <View style={styles.candidate} key={operation.id}>
            <Text style={styles.warning}>Notification history deletion {operation.status === "failed" ? "failed" : "waiting to sync"}</Text>
            {operation.status === "failed" && <Pressable onPress={() => void discardOperation(operation.id)}><Text style={styles.danger}>Discard</Text></Pressable>}
          </View>)}
          {enabled && candidates.length === 0 && <Text style={styles.body}>No payment candidates yet.</Text>}
        </View>

        {selectedCandidate && <View style={styles.card}>
          <Text style={styles.heading}>Review candidate</Text>
          <Text style={styles.body}>Notification details are a suggestion only. Verify each field before confirming.</Text>
          <TextInput value={amount} onChangeText={setAmount} keyboardType="decimal-pad" style={styles.input} placeholder={`Amount (${selectedCandidate.currency})`} />
          <TextInput value={description} onChangeText={setDescription} style={styles.input} placeholder="Description" />
          <Text style={styles.label}>Account</Text>
          <View style={styles.row}>{candidateAccounts.map((account) => <Pressable key={account.id} onPress={() => setAccountId(account.id)} style={[styles.chip,accountId === account.id && styles.selected]}>
            <Text style={accountId === account.id ? styles.selectedText : styles.chipText}>{account.name}</Text>
          </Pressable>)}</View>
          <Text style={styles.label}>Category (optional)</Text>
          <View style={styles.row}>
            <Pressable onPress={() => setCategoryId("")} style={[styles.chip,!categoryId && styles.selected]}><Text style={!categoryId ? styles.selectedText : styles.chipText}>None</Text></Pressable>
            {candidateCategories.map((category) => <Pressable key={category.id} onPress={() => setCategoryId(category.id)} style={[styles.chip,categoryId === category.id && styles.selected]}>
              <Text style={categoryId === category.id ? styles.selectedText : styles.chipText}>{category.name}</Text>
            </Pressable>)}
          </View>
          <View style={styles.row}>
            <Pressable style={styles.secondaryButton} onPress={() => setSelectedCandidate(null)}><Text style={styles.secondaryText}>Cancel</Text></Pressable>
            <Pressable style={styles.button} onPress={() => void confirmCandidate()} disabled={saving || !candidateAccounts.length}>
              <Text style={styles.buttonText}>{saving ? "Saving..." : "Confirm transaction"}</Text>
            </Pressable>
          </View>
        </View>}
        {operations.filter((operation) => operation.status === "failed").length > 0 && <Text style={styles.body}>Failed confirmations are retained until discarded. The candidate itself stays on this device so you can review it again.</Text>}
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: "#f4f7f4" },
  content: { padding: 18, gap: 14 },
  title: { fontSize: 30, fontWeight: "800", color: "#17332a" },
  card: { backgroundColor: "white", borderRadius: 14, padding: 16, borderWidth: 1, borderColor: "#e5ebe7", gap: 10 },
  heading: { color: "#17332a", fontSize: 18, fontWeight: "800" },
  body: { color: "#718078", lineHeight: 20 },
  label: { color: "#596962", fontWeight: "700" },
  switchRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  candidate: { borderTopWidth: 1, borderTopColor: "#e5ebe7", paddingVertical: 10, flexDirection: "row", alignItems: "center", gap: 10 },
  candidateText: { flex: 1, gap: 3 },
  row: { flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 7 },
  chip: { paddingVertical: 8, paddingHorizontal: 10, borderRadius: 18, backgroundColor: "#edf1ee" },
  selected: { backgroundColor: "#1f8059" },
  chipText: { color: "#52655c", fontSize: 12 },
  selectedText: { color: "white", fontSize: 12 },
  input: { borderWidth: 1, borderColor: "#d8e1dc", borderRadius: 9, padding: 11 },
  button: { backgroundColor: "#1f8059", borderRadius: 9, padding: 12, alignItems: "center" },
  buttonText: { color: "white", fontWeight: "800" },
  secondaryButton: { backgroundColor: "#edf1ee", borderRadius: 9, padding: 12, alignItems: "center" },
  secondaryText: { color: "#52655c", fontWeight: "700" },
  link: { color: "#1f8059", fontWeight: "800" },
  danger: { color: "#b33a34", fontWeight: "700" },
  error: { color: "#b33a34" },
  success: { color: "#1f8059" },
  warning: { color: "#91600c", fontSize: 12 },
});

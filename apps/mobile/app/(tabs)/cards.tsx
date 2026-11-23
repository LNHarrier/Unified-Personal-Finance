import { useCallback, useEffect, useMemo, useState } from "react";
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import * as SecureStore from "expo-secure-store";

const API_URL = process.env.EXPO_PUBLIC_API_URL ?? "http://10.0.2.2:3001";

type Card = {
  id: string;
  account_id: string;
  card_name: string;
  issuer?: string;
  currency: string;
  credit_limit_minor: number;
  outstanding_minor: number;
  available_limit_minor: number;
  linked_payment_account_id?: string | null;
};
type Account = { id: string; name: string; account_type: string; currency: string };

function formatMoney(minor: number, currency: string) {
  return new Intl.NumberFormat("en-IN", { style: "currency", currency }).format(minor / 100);
}

export default function Cards() {
  const [items, setItems] = useState<Card[]>([]);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [selectedCard, setSelectedCard] = useState<Card | null>(null);
  const [paymentAccountId, setPaymentAccountId] = useState("");
  const [amount, setAmount] = useState("");
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const paymentAccounts = useMemo(() => selectedCard
    ? accounts.filter((account) => ["bank", "cash"].includes(account.account_type) && account.currency === selectedCard.currency)
    : [], [accounts, selectedCard]);

  const refresh = useCallback(async () => {
    const token = await SecureStore.getItemAsync("upf_token");
    if (!token) throw new Error("Sign in again to view your credit cards.");
    const headers = { Authorization: `Bearer ${token}` };
    const [cardResponse, accountResponse] = await Promise.all([
      fetch(`${API_URL}/api/v1/credit-cards`, { headers }),
      fetch(`${API_URL}/api/v1/accounts`, { headers }),
    ]);
    const [cardData, accountData] = await Promise.all([cardResponse.json(), accountResponse.json()]);
    if (!cardResponse.ok || !accountResponse.ok) {
      throw new Error(cardData.message ?? accountData.message ?? "Unable to load credit card data.");
    }
    setItems(cardData.items);
    setAccounts(accountData.items);
  }, []);

  useEffect(() => {
    refresh().catch((cause) => setError(cause instanceof Error ? cause.message : "Unable to load credit cards."));
  }, [refresh]);

  const chooseCard = (card: Card) => {
    setSelectedCard(card);
    const validPaymentAccounts = accounts.filter((account) =>
      ["bank", "cash"].includes(account.account_type) && account.currency === card.currency);
    setPaymentAccountId(
      validPaymentAccounts.find((account) => account.id === card.linked_payment_account_id)?.id
      ?? validPaymentAccounts[0]?.id
      ?? "",
    );
    setAmount("");
    setError("");
  };

  const payBill = async () => {
    if (!selectedCard) return;
    setError("");
    setSaving(true);
    try {
      const token = await SecureStore.getItemAsync("upf_token");
      if (!token) throw new Error("Sign in again to continue.");
      const response = await fetch(`${API_URL}/api/v1/credit-cards/${selectedCard.id}/payment`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          paymentAccountId,
          amountMinor: Math.round(Number(amount) * 100),
          paymentAt: new Date().toISOString(),
          idempotencyKey: `card-payment-${Date.now()}-${Math.random()}`,
        }),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.message ?? "Credit card payment could not be saved.");
      setSelectedCard(null);
      setAmount("");
      await refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Credit card payment could not be saved.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <SafeAreaView style={styles.safe}>
      <Text style={styles.title}>Credit cards</Text>
      {error ? <Text style={styles.error} accessibilityRole="alert">{error}</Text> : null}
      <ScrollView>
        {items.map((item) => <View key={item.id} style={styles.card}>
          <Text style={styles.type}>{item.issuer ?? "Credit card"} · {item.currency}</Text>
          <Text style={styles.name}>{item.card_name}</Text>
          <View style={styles.metric}><Text>Outstanding</Text><Text style={styles.metricValue}>{formatMoney(item.outstanding_minor, item.currency)}</Text></View>
          <View style={styles.metric}><Text>Available limit</Text><Text style={styles.metricValue}>{formatMoney(item.available_limit_minor, item.currency)}</Text></View>
          <View style={styles.metric}><Text>Credit limit</Text><Text style={styles.metricValue}>{formatMoney(item.credit_limit_minor, item.currency)}</Text></View>
          <Pressable style={styles.button} onPress={() => chooseCard(item)} disabled={item.outstanding_minor <= 0}>
            <Text style={styles.buttonText}>Pay bill</Text>
          </Pressable>
        </View>)}
        {items.length === 0 && !error ? <Text style={styles.empty}>No credit cards yet.</Text> : null}
        {selectedCard && <View style={styles.form}>
          <Text style={styles.name}>Pay {selectedCard.card_name}</Text>
          <Text style={styles.label}>Pay from</Text>
          <View style={styles.row}>{paymentAccounts.map((account) => <Pressable
            key={account.id}
            onPress={() => setPaymentAccountId(account.id)}
            style={[styles.chip, paymentAccountId === account.id && styles.selected]}
          ><Text style={paymentAccountId === account.id ? styles.selectedText : styles.chipText}>{account.name}</Text></Pressable>)}</View>
          {paymentAccounts.length === 0 && <Text style={styles.error}>Add a bank or cash account in {selectedCard.currency} to pay this card.</Text>}
          <TextInput
            placeholder={`Amount (${selectedCard.currency})`}
            value={amount}
            onChangeText={setAmount}
            keyboardType="decimal-pad"
            style={styles.input}
          />
          <Text style={styles.hint}>Outstanding: {formatMoney(selectedCard.outstanding_minor, selectedCard.currency)}</Text>
          <View style={styles.row}>
            <Pressable style={styles.cancelButton} onPress={() => setSelectedCard(null)}><Text style={styles.chipText}>Cancel</Text></Pressable>
            <Pressable style={styles.button} onPress={payBill} disabled={saving || paymentAccounts.length === 0 || !amount || Number(amount) <= 0}>
              <Text style={styles.buttonText}>{saving ? "Saving..." : "Record payment"}</Text>
            </Pressable>
          </View>
        </View>}
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: "#f4f7f4", padding: 18 },
  title: { fontSize: 30, fontWeight: "800", color: "#17332a", marginBottom: 18 },
  card: { backgroundColor: "white", borderRadius: 14, padding: 16, marginBottom: 10, borderWidth: 1, borderColor: "#e5ebe7" },
  type: { color: "#718078", textTransform: "capitalize" },
  name: { color: "#17332a", fontSize: 18, fontWeight: "800", marginTop: 4 },
  metric: { flexDirection: "row", justifyContent: "space-between", marginTop: 10 },
  metricValue: { color: "#17332a", fontWeight: "700" },
  form: { backgroundColor: "white", borderRadius: 14, padding: 16, marginBottom: 14, borderWidth: 1, borderColor: "#e5ebe7", gap: 10 },
  label: { color: "#596962", fontWeight: "700" },
  hint: { color: "#718078" },
  row: { flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 8 },
  chip: { paddingVertical: 8, paddingHorizontal: 10, borderRadius: 18, backgroundColor: "#edf1ee" },
  selected: { backgroundColor: "#1f8059" },
  chipText: { color: "#52655c", fontSize: 12 },
  selectedText: { color: "white", fontSize: 12 },
  input: { borderWidth: 1, borderColor: "#d8e1dc", borderRadius: 9, padding: 11 },
  button: { backgroundColor: "#1f8059", borderRadius: 9, padding: 12, alignItems: "center" },
  buttonText: { color: "white", fontWeight: "800" },
  cancelButton: { backgroundColor: "#edf1ee", borderRadius: 9, padding: 12, alignItems: "center" },
  error: { color: "#b33a34", marginBottom: 10 },
  empty: { color: "#718078" },
});

import { useEffect, useState } from "react";
import { ScrollView, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import * as SecureStore from "expo-secure-store";

const API_URL = process.env.EXPO_PUBLIC_API_URL ?? "http://10.0.2.2:3001";

type Budget = {
  id: string;
  name: string;
  period_type: string;
  total_limit_minor: number;
  spent_minor: number;
  currency: string;
  category_names?: string;
};
type CategoryAllocation = {
  categoryId: string;
  categoryName: string;
  limitMinor: number;
  spentMinor: number;
  remainingMinor: number;
};

export default function Budgets() {
  const [items, setItems] = useState<Budget[]>([]);
  const [allocations, setAllocations] = useState<Record<string, CategoryAllocation[]>>({});
  const [error, setError] = useState("");
  useEffect(() => {
    let active = true;
    async function loadBudgets() {
      try {
        const token = await SecureStore.getItemAsync("upf_token");
        if (!token) throw new Error("Please sign in again to view budgets.");
        const response = await fetch(`${API_URL}/api/v1/budgets`, { headers: { Authorization: `Bearer ${token}` } });
        const body: { items: Budget[]; message?: string } = await response.json();
        if (!response.ok) throw new Error(body.message ?? "Could not load budgets.");
        const performanceByBudget = await Promise.all(body.items.map(async (budget) => {
          const performanceResponse = await fetch(
            `${API_URL}/api/v1/budgets/${budget.id}/performance`,
            { headers: { Authorization: `Bearer ${token}` } },
          );
          const performance: { categoryAllocations: CategoryAllocation[]; message?: string } = await performanceResponse.json();
          if (!performanceResponse.ok) throw new Error(performance.message ?? "Could not load category budget performance.");
          return [budget.id, performance.categoryAllocations] as const;
        }));
        if (active) {
          setItems(body.items);
          setAllocations(Object.fromEntries(performanceByBudget));
          setError("");
        }
      } catch (cause) {
        if (active) setError(cause instanceof Error ? cause.message : "Could not load budgets.");
      }
    }
    void loadBudgets();
    return () => { active = false; };
  }, []);
  return (
    <SafeAreaView style={styles.safe}>
      <Text style={styles.title}>Budgets</Text>
      {error ? <Text style={styles.error}>{error}</Text> : null}
      <ScrollView>{items.map((item) => {
        const remaining = item.total_limit_minor - item.spent_minor;
        const usage = item.total_limit_minor > 0
          ? Math.min(100, (item.spent_minor / item.total_limit_minor) * 100)
          : 0;
        return <View key={item.id} style={styles.card}>
          <Text style={styles.type}>{item.period_type}</Text>
          <Text style={styles.name}>{item.name}</Text>
          {item.category_names ? <Text style={styles.type}>{item.category_names}</Text> : null}
          <Text style={styles.amount}>Spent ₹{(item.spent_minor / 100).toLocaleString("en-IN")} of ₹{(item.total_limit_minor / 100).toLocaleString("en-IN")}</Text>
          <View style={styles.track}><View style={[styles.fill, { width: `${usage}%` }]} /></View>
          <Text style={remaining < 0 ? styles.error : styles.type}>
            {remaining < 0 ? "Over budget by" : "Remaining"} ₹{(Math.abs(remaining) / 100).toLocaleString("en-IN")}
          </Text>
          {allocations[item.id]?.map((allocation) => {
            const categoryUsage = allocation.limitMinor > 0
              ? Math.min(100, (allocation.spentMinor / allocation.limitMinor) * 100)
              : 0;
            return <View style={styles.allocation} key={allocation.categoryId}>
              <Text style={styles.type}>{allocation.categoryName}</Text>
              <Text style={styles.type}>₹{(allocation.spentMinor / 100).toLocaleString("en-IN")} / ₹{(allocation.limitMinor / 100).toLocaleString("en-IN")}</Text>
              <View style={styles.track}><View style={[styles.fill, allocation.spentMinor > allocation.limitMinor && styles.overFill, { width: `${categoryUsage}%` }]} /></View>
              <Text style={allocation.remainingMinor < 0 ? styles.error : styles.type}>
                {allocation.remainingMinor < 0 ? "Over allocation by" : "Allocation remaining"} ₹{(Math.abs(allocation.remainingMinor) / 100).toLocaleString("en-IN")}
              </Text>
            </View>;
          })}
        </View>;
      })}</ScrollView>
    </SafeAreaView>
  );
}
const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: "#f4f7f4", padding: 18 },
  title: { fontSize: 30, fontWeight: "800", color: "#17332a", marginBottom: 18 },
  card: { backgroundColor: "white", borderRadius: 14, padding: 16, marginBottom: 10, borderWidth: 1, borderColor: "#e5ebe7" },
  type: { color: "#718078", textTransform: "capitalize" },
  name: { color: "#17332a", fontSize: 18, fontWeight: "800", marginTop: 4 },
  amount: { color: "#1f8059", fontWeight: "800", marginTop: 8 },
  allocation: { borderTopWidth: 1, borderTopColor: "#edf1ee", marginTop: 10, paddingTop: 10 },
  track: { height: 8, borderRadius: 8, backgroundColor: "#edf1ee", marginVertical: 10, overflow: "hidden" },
  fill: { height: 8, borderRadius: 8, backgroundColor: "#d69a55" },
  overFill: { backgroundColor: "#c94f4f" },
  error: { color: "#b33a34", marginBottom: 10 },
});
